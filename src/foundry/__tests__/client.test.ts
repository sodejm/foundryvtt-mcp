import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock dependencies
vi.mock('axios');
vi.mock('socket.io-client');
vi.mock('../auth.js', () => ({
  authenticateFoundry: vi
    .fn()
    .mockResolvedValue({ session: 'test-session', userId: 'test-user-id' }),
  // Real implementation — connectAndLoadWorld's handshake options are the
  // subject of the #206 regression test below.
  sessionSocketOptions: (session: string) => ({
    transports: ['websocket'],
    query: { session },
    extraHeaders: { Cookie: `session=${session}` },
  }),
}));
vi.mock('../../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock('../../config/index.js', () => ({
  config: {
    logLevel: 'info',
  },
}));

const { FoundryClient } = await import('../client.js');

const mockAxios = vi.mocked(axios);

describe('FoundryClient', () => {
  let client: InstanceType<typeof FoundryClient>;
  let mockAxiosInstance: any;

  beforeEach(() => {
    mockAxiosInstance = {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      request: vi.fn(),
      interceptors: {
        request: { use: vi.fn() },
        response: { use: vi.fn() },
      },
    };

    vi.clearAllMocks();
    mockAxios.create = vi.fn().mockReturnValue(mockAxiosInstance);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('constructor', () => {
    it('should create instance with default config', () => {
      client = new FoundryClient({ baseUrl: 'http://localhost:30000' });
      expect(client).toBeDefined();
      expect(client.isConnected()).toBe(false);
    });

    it('should throw on empty baseUrl', () => {
      expect(() => new FoundryClient({ baseUrl: '' })).toThrow('baseUrl is required');
    });

    it('should throw on invalid baseUrl', () => {
      expect(() => new FoundryClient({ baseUrl: 'not-a-url' })).toThrow('Invalid baseUrl');
    });

    it('should configure axios with apiKey interceptor when provided', () => {
      client = new FoundryClient({ baseUrl: 'http://localhost:30000', apiKey: 'test-key' });
      expect(mockAxios.create).toHaveBeenCalled();
    });
  });

  describe('testConnection', () => {
    it.each([
      { username: 'gm', password: 'secret' },
      { username: 'gm', password: '' },
      { userId: 'User000000000001', password: '' },
      { apiKey: 'test-api-key' },
    ])('loads the authenticated connection for %j', async (credentials) => {
      client = new FoundryClient({ baseUrl: 'http://localhost:30000', ...credentials });
      const connect = vi.spyOn(client, 'connect').mockResolvedValue();

      await expect(client.testConnection()).resolves.toBe(true);

      expect(connect).toHaveBeenCalledOnce();
      expect(mockAxiosInstance.get).not.toHaveBeenCalled();
    });

    it.each([
      {},
      { username: 'gm' },
      { password: '' },
    ])('only checks HTTP reachability when authentication is incomplete: %j', async (credentials) => {
      client = new FoundryClient({ baseUrl: 'http://localhost:30000', ...credentials });
      const connect = vi.spyOn(client, 'connect');
      mockAxiosInstance.get.mockResolvedValue({ status: 200 });

      await expect(client.testConnection()).resolves.toBe(true);

      expect(connect).not.toHaveBeenCalled();
      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/');
    });

    it('propagates authentication errors instead of falling back to HTTP reachability', async () => {
      client = new FoundryClient({
        baseUrl: 'http://localhost:30000',
        username: 'gm',
        password: '',
      });
      vi.spyOn(client, 'connect').mockRejectedValue(new Error('Authentication failed'));

      await expect(client.testConnection()).rejects.toThrow('Authentication failed');
      expect(mockAxiosInstance.get).not.toHaveBeenCalled();
    });
  });

  describe('REST API mode (with apiKey)', () => {
    beforeEach(() => {
      client = new FoundryClient({
        baseUrl: 'http://localhost:30000',
        apiKey: 'test-api-key',
      });
    });

    it('should connect via REST API', async () => {
      mockAxiosInstance.get.mockResolvedValue({ status: 200, data: {} });
      await client.connect();
      expect(client.isConnected()).toBe(true);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/api/status');
    });

    it('should search actors via REST API', async () => {
      const mockData = {
        actors: [{ _id: 'Actor00000000001', name: 'Hero', type: 'character' }],
        total: 1,
        page: 1,
        limit: 10,
      };
      mockAxiosInstance.get.mockResolvedValue({ data: mockData });

      const result = await client.searchActors({ query: 'Hero' });
      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/api/actors', {
        params: { query: 'Hero', page: 1, limit: 100 },
      });
      expect(result.actors).toEqual(mockData.actors);
    });

    it('should search items via REST API', async () => {
      const mockData = {
        items: [{ _id: 'Item000000000001', name: 'Sword', type: 'weapon' }],
        total: 1,
        page: 1,
        limit: 10,
      };
      mockAxiosInstance.get.mockResolvedValue({ data: mockData });

      const result = await client.searchItems({ query: 'Sword', type: 'weapon', limit: 10 });
      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/api/items', {
        params: { page: 1, limit: 100 },
      });
      expect(result.items).toMatchObject(mockData.items);
    });

    it('should get world info via REST API', async () => {
      const mockWorld = { id: 'world-1', title: 'Test World', system: 'dnd5e' };
      mockAxiosInstance.get.mockResolvedValue({ data: mockWorld });

      const result = await client.getWorldInfo();
      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/api/world');
      expect(result).toEqual(mockWorld);
    });

    it('should retry failed requests', async () => {
      client = new FoundryClient({
        baseUrl: 'http://localhost:30000',
        apiKey: 'test-api-key',
        retryAttempts: 2,
        retryDelay: 10,
      });

      mockAxiosInstance.get
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({ data: { actors: [], total: 0, page: 1, limit: 10 } });

      const result = await client.searchActors({ query: 'test' });
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(3);
      expect(result.actors).toEqual([]);
    });

    it('should fail after max retry attempts', async () => {
      client = new FoundryClient({
        baseUrl: 'http://localhost:30000',
        apiKey: 'test-api-key',
        retryAttempts: 1,
        retryDelay: 10,
      });

      mockAxiosInstance.get.mockRejectedValue(new Error('Persistent error'));

      await expect(client.searchActors({ query: 'test' })).rejects.toThrow('Persistent error');
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(2); // Initial + 1 retry
    });

    /**
     * #217, in the transport that still had it: `_isConnected` latched true at
     * the connect probe and cleared only inside `disconnect()`, so a server
     * restart went on reading as "✅ Connected" forever. There is no socket to
     * ask here, so liveness follows the outcome of the REST requests that do
     * happen — no extra I/O, and `isConnected()` stays synchronous.
     */
    describe('liveness after the connect probe', () => {
      /** The response interceptor the client registered, as axios would call it. */
      function interceptor() {
        const [onFulfilled, onRejected] = mockAxiosInstance.interceptors.response.use.mock
          .calls[0] as [
          (response: unknown) => unknown,
          (error: unknown) => Promise<never>,
          ...unknown[],
        ];
        return { onFulfilled, onRejected };
      }

      /** An axios rejection with no HTTP response — the server never answered. */
      function transportFailure() {
        return Object.assign(new Error('connect ECONNREFUSED'), { isAxiosError: true });
      }

      /** An axios rejection carrying a reply — the server answered, badly. */
      function httpError(status: number) {
        return Object.assign(new Error(`HTTP ${status}`), {
          isAxiosError: true,
          response: { status },
        });
      }

      beforeEach(async () => {
        mockAxiosInstance.get.mockResolvedValue({ status: 200, data: {} });
        await client.connect();
        expect(client.isConnected()).toBe(true);
      });

      it('reports disconnected once a request finds the server gone', async () => {
        const { onRejected } = interceptor();

        await expect(onRejected(transportFailure())).rejects.toThrow('ECONNREFUSED');

        expect(client.isConnected()).toBe(false);
      });

      it('reports connected again once a request succeeds', async () => {
        const { onFulfilled, onRejected } = interceptor();
        await expect(onRejected(transportFailure())).rejects.toThrow('ECONNREFUSED');

        onFulfilled({ status: 200, data: {} });

        expect(client.isConnected()).toBe(true);
      });

      it('treats an error status as reachable — the server answered', async () => {
        const { onRejected } = interceptor();

        await expect(onRejected(httpError(500))).rejects.toThrow('HTTP 500');

        expect(client.isConnected()).toBe(true);
      });
    });
  });

  /**
   * CN-6: retry/backoff matrix (Issue #136).
   *
   * Verifies the documented exception list:
   *   - 4xx errors (except 429) fail fast — no retry.
   *   - 429 is retried alongside 5xx and transport errors.
   *   - Backoff delays follow baseDelay * 2^(attempt-1) (within jitter).
   */
  describe('retry/backoff matrix (CN-6)', () => {
    /** Construct a 4xx-shaped AxiosError so executeWithRetry recognises it. */
    function build4xxError(status: number) {
      const err = new Error(`HTTP ${status}`) as Error & {
        isAxiosError: boolean;
        response: { status: number };
      };
      err.isAxiosError = true;
      err.response = { status };
      return err;
    }

    beforeEach(() => {
      // Make the mocked axios.isAxiosError honour our flagged errors so
      // executeWithRetry's status-based fail-fast branch is exercised.
      mockAxios.isAxiosError = ((e: unknown): e is { response?: { status?: number } } =>
        typeof e === 'object' &&
        e !== null &&
        (e as { isAxiosError?: boolean }).isAxiosError === true) as typeof axios.isAxiosError;
    });

    it('does NOT retry on 400 Bad Request', async () => {
      client = new FoundryClient({
        baseUrl: 'http://localhost:30000',
        apiKey: 'test-api-key',
        retryAttempts: 3,
        retryDelay: 10,
      });

      mockAxiosInstance.get.mockRejectedValue(build4xxError(400));

      await expect(client.searchActors({ query: 'x' })).rejects.toThrow('HTTP 400');
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1);
    });

    it('does NOT retry on 404 Not Found', async () => {
      client = new FoundryClient({
        baseUrl: 'http://localhost:30000',
        apiKey: 'test-api-key',
        retryAttempts: 3,
        retryDelay: 10,
      });

      mockAxiosInstance.get.mockRejectedValue(build4xxError(404));

      await expect(client.searchActors({ query: 'x' })).rejects.toThrow('HTTP 404');
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1);
    });

    it('does NOT retry on 401 Unauthorized', async () => {
      client = new FoundryClient({
        baseUrl: 'http://localhost:30000',
        apiKey: 'test-api-key',
        retryAttempts: 3,
        retryDelay: 10,
      });

      mockAxiosInstance.get.mockRejectedValue(build4xxError(401));

      await expect(client.searchActors({ query: 'x' })).rejects.toThrow('HTTP 401');
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1);
    });

    it('DOES retry on 429 Too Many Requests (documented exception)', async () => {
      client = new FoundryClient({
        baseUrl: 'http://localhost:30000',
        apiKey: 'test-api-key',
        retryAttempts: 2,
        retryDelay: 10,
      });

      mockAxiosInstance.get
        .mockRejectedValueOnce(build4xxError(429))
        .mockRejectedValueOnce(build4xxError(429))
        .mockResolvedValueOnce({ data: { actors: [], total: 0, page: 1, limit: 10 } });

      const result = await client.searchActors({ query: 'x' });
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(3);
      expect(result.actors).toEqual([]);
    });

    it('DOES retry on 500 Internal Server Error', async () => {
      client = new FoundryClient({
        baseUrl: 'http://localhost:30000',
        apiKey: 'test-api-key',
        retryAttempts: 1,
        retryDelay: 10,
      });

      mockAxiosInstance.get
        .mockRejectedValueOnce(build4xxError(500))
        .mockResolvedValueOnce({ data: { actors: [], total: 0, page: 1, limit: 10 } });

      const result = await client.searchActors({ query: 'x' });
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(2);
      expect(result.actors).toEqual([]);
    });

    it('DOES retry on 503 Service Unavailable', async () => {
      client = new FoundryClient({
        baseUrl: 'http://localhost:30000',
        apiKey: 'test-api-key',
        retryAttempts: 1,
        retryDelay: 10,
      });

      mockAxiosInstance.get
        .mockRejectedValueOnce(build4xxError(503))
        .mockResolvedValueOnce({ data: { actors: [], total: 0, page: 1, limit: 10 } });

      await client.searchActors({ query: 'x' });
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(2);
    });

    it('uses exponential backoff (baseDelay * 2^(attempt-1), within jitter)', async () => {
      const baseDelay = 100;
      client = new FoundryClient({
        baseUrl: 'http://localhost:30000',
        apiKey: 'test-api-key',
        retryAttempts: 3,
        retryDelay: baseDelay,
      });

      // Fail twice, succeed third — produces two backoff waits.
      mockAxiosInstance.get
        .mockRejectedValueOnce(new Error('transient'))
        .mockRejectedValueOnce(new Error('transient'))
        .mockResolvedValueOnce({ data: { actors: [], total: 0, page: 1, limit: 10 } });

      const start = Date.now();
      await client.searchActors({ query: 'x' });
      const elapsed = Date.now() - start;

      // Expected minimum delay: 100ms (attempt 1) + 200ms (attempt 2) = 300ms.
      // Allow generous upper bound for jitter + scheduler noise.
      expect(elapsed).toBeGreaterThanOrEqual(290);
      expect(elapsed).toBeLessThan(600);
    });
  });

  describe('worldData mode (no apiKey)', () => {
    it('should report unavailable backend when no worldData', async () => {
      client = new FoundryClient({ baseUrl: 'http://localhost:30000' });

      await expect(client.searchActors({ query: 'test' })).rejects.toThrow(
        'World data unavailable',
      );
      await expect(client.searchItems({ query: 'test' })).rejects.toThrow('World data unavailable');
    });

    it('should reject world info when no snapshot has been captured', async () => {
      client = new FoundryClient({ baseUrl: 'http://localhost:30000' });
      await expect(client.getWorldInfo()).rejects.toThrow('World data unavailable');
    });

    it('should require credentials for connect in Socket.IO mode', async () => {
      client = new FoundryClient({ baseUrl: 'http://localhost:30000' });
      await expect(client.connect()).rejects.toThrow('Socket.IO mode requires');
    });

    it('should reject combat state when no snapshot has been captured', () => {
      client = new FoundryClient({ baseUrl: 'http://localhost:30000' });
      expect(() => client.getCombatState()).toThrow('World data unavailable');
    });

    it('should reject chat messages when no snapshot has been captured', () => {
      client = new FoundryClient({ baseUrl: 'http://localhost:30000' });
      expect(() => client.getChatMessages()).toThrow('World data unavailable');
    });

    it('should reject users when no snapshot has been captured', () => {
      client = new FoundryClient({ baseUrl: 'http://localhost:30000' });
      expect(() => client.getUsers()).toThrow('World data unavailable');
    });

    it('should reject journals when no snapshot has been captured', () => {
      client = new FoundryClient({ baseUrl: 'http://localhost:30000' });
      expect(() => client.getJournals()).toThrow('World data unavailable');
    });

    it('should reject world search when no snapshot has been captured', () => {
      client = new FoundryClient({ baseUrl: 'http://localhost:30000' });
      expect(() => client.searchWorld('test')).toThrow('World data unavailable');
    });

    it('should reject summary when no snapshot has been captured', () => {
      client = new FoundryClient({ baseUrl: 'http://localhost:30000' });
      expect(() => client.getWorldSummary()).toThrow('World data unavailable');
    });
  });

  describe('bounded dice rolling and engine selection', () => {
    const paired = {
      restUrl: 'http://localhost:3010',
      restApiKey: 'fixture-key',
      restClientId: 'paired-client',
    };
    beforeEach(() => {
      client = new FoundryClient({ baseUrl: 'http://localhost:30000' });
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
    });
    afterEach(() => vi.restoreAllMocks());

    it.each([
      ['1d20+5', 15],
      ['1d20 + 5', 15],
      ['1d20+5+3', 18],
      ['d20', 10],
      ['2d6+1d4', 8],
      ['2d6 - 1', 5],
      ['(4d6kh3+2)-1', 10],
    ])('evaluates the complete expression %s', async (formula, total) => {
      const result = await client.rollDice(formula as string, 'attack');
      expect(result).toMatchObject({
        schemaVersion: 1,
        engine: 'local',
        total,
        reason: 'attack',
        fallback: { requestedEngine: 'auto', reason: 'foundry-transport-not-configured' },
      });
      expect(result.breakdown.endsWith(` = ${total}`)).toBe(true);
      expect(result.timestamp).toMatch(/^\d{4}-/);
      expect(mockAxiosInstance.post).not.toHaveBeenCalled();
    });

    it.each([
      '',
      'DROP TABLE',
      '(1d20+5)*2',
      '1d20r1',
      '1d20+STR',
      '1d20+',
      '1d20 5',
      '1d0',
      '1000d6',
    ])('rejects invalid formula %s before randomness or transport', async (formula) => {
      await expect(client.rollDice(formula)).rejects.toMatchObject({ code: -32602 });
      expect(Math.random).not.toHaveBeenCalled();
      expect(mockAxiosInstance.post).not.toHaveBeenCalled();
    });

    it('requires a configured Foundry transport for explicit native execution', async () => {
      await expect(client.rollDice('d6', undefined, 'foundry')).rejects.toThrow('not configured');
      expect(Math.random).not.toHaveBeenCalled();
    });

    it.each([
      { restUrl: paired.restUrl },
      { restApiKey: paired.restApiKey },
      { restClientId: paired.restClientId },
      { restUrl: paired.restUrl, restApiKey: paired.restApiKey },
      { restUrl: paired.restUrl, restClientId: paired.restClientId },
      { restApiKey: paired.restApiKey, restClientId: paired.restClientId },
    ])('rejects partial native configuration %j', async (config) => {
      client = new FoundryClient({ baseUrl: 'http://localhost:30000', ...config });
      await expect(client.rollDice('d6')).rejects.toThrow('Configure all');
      expect(Math.random).not.toHaveBeenCalled();
      expect(mockAxiosInstance.post).not.toHaveBeenCalled();
      expect(await client.rollDice('d6', undefined, 'local')).toMatchObject({
        engine: 'local',
        total: 3,
        fallback: null,
      });
    });

    it('rejects the legacy-only dice route while allowing explicit local evaluation', async () => {
      client = new FoundryClient({ baseUrl: 'http://localhost:30000', apiKey: 'legacy-key' });
      await expect(client.rollDice('d6')).rejects.toThrow('Legacy');
      expect(mockAxiosInstance.post).not.toHaveBeenCalled();
      expect(await client.rollDice('d6', undefined, 'local')).toMatchObject({
        engine: 'local',
        total: 3,
        fallback: null,
      });
    });

    it.each([
      'auto',
      'foundry',
    ] as const)('selects paired Foundry execution for %s even with legacy configuration', async (engine) => {
      client = new FoundryClient({
        baseUrl: 'http://localhost:30000',
        ...paired,
        apiKey: 'legacy-key',
      });
      mockAxiosInstance.post.mockResolvedValue({
        data: {
          type: 'roll-result',
          requestId: 'fixture',
          success: true,
          data: {
            id: 'manual_fixture',
            chatMessageCreated: false,
            roll: {
              formula: '1d6 + 3',
              total: 9,
              timestamp: 0,
              dice: [{ faces: 6, results: [{ result: 6, active: true }] }],
            },
          },
        },
      });
      const result = await client.rollDice('d6+3', 'attack', engine);
      expect(result).toMatchObject({
        engine: 'foundry',
        total: 9,
        normalizedFormula: '1d6 + 3',
        fallback: null,
        dice: [
          {
            termIndex: 0,
            faces: 6,
            count: 1,
            modifier: null,
            results: [{ result: 6, active: true }],
          },
        ],
      });
      expect(result.timestamp).toBe('1970-01-01T00:00:00.000Z');
      expect(Math.random).not.toHaveBeenCalled();
      expect(mockAxiosInstance.post).toHaveBeenCalledOnce();
    });

    it('never calls a configured native transport for explicit local execution', async () => {
      client = new FoundryClient({ baseUrl: 'http://localhost:30000', ...paired });
      expect(await client.rollDice('d6', undefined, 'local')).toMatchObject({
        engine: 'local',
        total: 3,
        fallback: null,
      });
      expect(mockAxiosInstance.post).not.toHaveBeenCalled();
    });

    it.each(['network', 'malformed'])('never rerolls after a %s native failure', async (kind) => {
      client = new FoundryClient({ baseUrl: 'http://localhost:30000', ...paired });
      if (kind === 'network') {
        mockAxiosInstance.post.mockRejectedValue(new Error('fixture-key'));
      } else {
        mockAxiosInstance.post.mockResolvedValue({ data: { total: 10 } });
      }
      await expect(client.rollDice('d6')).rejects.toThrow('no retry or local fallback');
      expect(mockAxiosInstance.post).toHaveBeenCalledOnce();
      expect(Math.random).not.toHaveBeenCalled();
    });
  });

  describe('disconnect', () => {
    it('should reset state on disconnect', async () => {
      client = new FoundryClient({ baseUrl: 'http://localhost:30000' });
      await client.disconnect();
      expect(client.isConnected()).toBe(false);
      expect(client.hasWorldData()).toBe(false);
    });
  });

  describe('world snapshot refresh lifecycle', () => {
    const ACTOR_ID = 'Actor00000000001';
    const WORLD_SNAPSHOT = {
      userId: 'test-user-id',
      release: { version: '12.331' },
      world: { id: 'world-1', title: 'Test World' },
      system: { id: 'dnd5e', version: '3.3.1' },
      modules: [],
      demoMode: false,
      actors: [{ _id: ACTOR_ID, name: 'Before refresh', type: 'npc', system: {} }],
      scenes: [],
      items: [],
      journal: [],
      messages: [],
      combats: [],
      users: [{ _id: 'user-aaaaaaaaaaaaaa', name: 'GM', role: 4 }],
      activeUsers: [],
      settings: [],
      macros: [],
      playlists: [],
      tables: [],
      folders: [],
      cards: [],
      packs: [],
    };

    function buildMockSocket() {
      const worldAcks: Array<(payload: unknown) => void> = [];
      const modifyAcks: Array<(payload: unknown) => void> = [];
      const socket = {
        connected: true,
        emit: vi.fn((event: string, ...args: unknown[]) => {
          const ack = args.at(-1);
          if (event === 'world' && typeof ack === 'function') {
            worldAcks.push(ack as (payload: unknown) => void);
          }
          if (event === 'modifyDocument' && typeof ack === 'function') {
            modifyAcks.push(ack as (payload: unknown) => void);
          }
          return socket;
        }),
        disconnect: vi.fn(),
      };
      return { socket, worldAcks, modifyAcks };
    }

    function attachSocket(socket: ReturnType<typeof buildMockSocket>['socket']) {
      Reflect.set(client, 'socket', socket);
      Reflect.set(client, 'socketGeneration', 1);
      Reflect.set(client, 'socketEpoch', 1);
      Reflect.set(client, 'socketUserId', 'test-user-id');
      Reflect.set(client, '_isConnected', true);
    }

    it('uses an acknowledgement callback and coalesces concurrent refreshes', async () => {
      client = new FoundryClient({
        baseUrl: 'http://localhost:30000',
        timeout: 50,
        retryAttempts: 0,
      });
      const { socket, worldAcks } = buildMockSocket();
      attachSocket(socket);

      const first = client.refreshWorldData();
      const second = client.refreshWorldData();

      expect(worldAcks).toHaveLength(1);
      worldAcks[0]?.(structuredClone(WORLD_SNAPSHOT));
      await Promise.all([first, second]);

      expect(socket.emit).toHaveBeenCalledWith('world', expect.any(Function));
      expect(client.getReadMetadata()).toMatchObject({
        source: 'socket',
        freshness: 'current',
        worldId: 'world-1',
        revision: 1,
      });
      expect((await client.getWorldInfo()).title).toBe('Test World');
    });

    it('rejects a timed-out refresh and ignores its late acknowledgement', async () => {
      vi.useFakeTimers();
      try {
        client = new FoundryClient({
          baseUrl: 'http://localhost:30000',
          timeout: 25,
          retryAttempts: 0,
        });
        const { socket, worldAcks } = buildMockSocket();
        attachSocket(socket);

        const refresh = client.refreshWorldData();
        const rejected = expect(refresh).rejects.toThrow('ACK timed out');
        await vi.advanceTimersByTimeAsync(26);
        await rejected;

        worldAcks[0]?.(structuredClone(WORLD_SNAPSHOT));
        await Promise.resolve();
        expect(client.hasWorldData()).toBe(false);
        expect(client.getReadMetadata().freshness).toBe('unavailable');
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not publish malformed or retired acknowledgements', async () => {
      client = new FoundryClient({
        baseUrl: 'http://localhost:30000',
        timeout: 50,
        retryAttempts: 0,
      });
      const first = buildMockSocket();
      attachSocket(first.socket);
      const malformed = client.refreshWorldData();
      first.worldAcks[0]?.({ ...WORLD_SNAPSHOT, actors: null });
      await expect(malformed).rejects.toThrow('snapshot validation failed');
      expect(client.hasWorldData()).toBe(false);

      const retired = client.refreshWorldData();
      Reflect.set(client, 'socketEpoch', 2);
      first.worldAcks[1]?.(structuredClone(WORLD_SNAPSHOT));
      await expect(retired).rejects.toThrow(/retired socket session/i);
      expect(client.hasWorldData()).toBe(false);
    });

    it('replays document and presence events received during refresh', async () => {
      client = new FoundryClient({
        baseUrl: 'http://localhost:30000',
        timeout: 50,
        retryAttempts: 0,
      });
      const { socket, worldAcks } = buildMockSocket();
      attachSocket(socket);

      const refresh = client.refreshWorldData();
      Reflect.get(
        client,
        'onDocumentBroadcast',
      )({
        type: 'Actor',
        action: 'update',
        result: [{ _id: ACTOR_ID, name: 'During refresh' }],
      });
      Reflect.get(client, 'onUserActivity')('user-aaaaaaaaaaaaaa', { active: true });
      worldAcks[0]?.(structuredClone(WORLD_SNAPSHOT));
      await refresh;

      expect(client.getRawActor(ACTOR_ID)?.name).toBe('During refresh');
      expect(client.getUsers().activeUsers).toEqual(['user-aaaaaaaaaaaaaa']);
    });

    it('applies an authoritative write acknowledgement when no broadcast returns to the writer', async () => {
      client = new FoundryClient({
        baseUrl: 'http://localhost:30000',
        timeout: 50,
        retryAttempts: 0,
        writeEnabled: true,
      });
      const { socket, worldAcks, modifyAcks } = buildMockSocket();
      attachSocket(socket);
      const refresh = client.refreshWorldData();
      worldAcks[0]?.(structuredClone(WORLD_SNAPSHOT));
      await refresh;

      const modifyDocument = Reflect.get(client, 'modifyDocument').bind(client) as (
        type: string,
        action: string,
        operation: Record<string, unknown>,
      ) => Promise<unknown>;
      const update = modifyDocument('Actor', 'update', {
        updates: [{ _id: ACTOR_ID, name: 'Acknowledged update' }],
      });
      modifyAcks[0]?.({ result: [{ _id: ACTOR_ID, name: 'Acknowledged update' }] });
      await update;

      expect(client.getRawActor(ACTOR_ID)?.name).toBe('Acknowledged update');
      expect(client.getReadMetadata().revision).toBe(2);
    });
  });

  /**
   * Issue #217 — liveness must come from the socket, not a latched flag.
   *
   * `_isConnected` used to be cleared only by an explicit `disconnect()`, so a
   * socket that dropped on its own (server restart, network loss) still read as
   * connected and `get_health_status` still printed "✅ Connected".
   */
  describe('socket liveness (#217) and live presence (#218)', () => {
    /** Mock socket that records listeners and lets the test fire them. */
    function buildHandshakeSocket(worldData: Record<string, unknown>) {
      const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
      const socket = {
        connected: true,
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          const existing = listeners.get(event) ?? [];
          existing.push(handler);
          listeners.set(event, existing);
          return socket;
        }),
        once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          const existing = listeners.get(event) ?? [];
          existing.push(handler);
          listeners.set(event, existing);
          return socket;
        }),
        off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          const remaining = (listeners.get(event) ?? []).filter((h) => h !== handler);
          listeners.set(event, remaining);
          return socket;
        }),
        emit: vi.fn((event: string, ack?: (payload: unknown) => void) => {
          if (event === 'world' && typeof ack === 'function') {
            ack(worldData);
          }
          return socket;
        }),
        disconnect: vi.fn(() => {
          socket.connected = false;
          return socket;
        }),
      };
      const fire = (event: string, ...args: unknown[]) => {
        for (const handler of [...(listeners.get(event) ?? [])]) {
          handler(...args);
        }
      };
      return { socket, listeners, fire };
    }

    const WORLD_DATA = {
      userId: 'test-user-id',
      world: { id: 'w', title: 'Test World' },
      system: { id: 'dnd5e', version: '3.3.1' },
      release: { version: '12.331' },
      modules: [],
      demoMode: false,
      actors: [],
      scenes: [],
      items: [],
      journal: [],
      messages: [],
      combats: [],
      users: [
        { _id: 'user-aaaaaaaaaaaaaa', name: 'GM', role: 4 },
        { _id: 'user-bbbbbbbbbbbbbb', name: 'Player', role: 1 },
      ],
      activeUsers: ['user-aaaaaaaaaaaaaa'],
      settings: [],
      macros: [],
      playlists: [],
      tables: [],
      folders: [],
      cards: [],
      packs: [],
    };

    async function connectWithMockSocket(existing?: FoundryClient) {
      const { io } = await import('socket.io-client');
      const { authenticateFoundry } = await import('../auth.js');
      // afterEach's resetAllMocks() clears the module-factory resolved value.
      vi.mocked(authenticateFoundry).mockResolvedValue({
        session: 'test-session',
        userId: 'test-user-id',
      });
      const harness = buildHandshakeSocket(structuredClone(WORLD_DATA));
      vi.mocked(io).mockReturnValue(harness.socket as never);

      const connected =
        existing ??
        new FoundryClient({
          baseUrl: 'http://localhost:30000',
          username: 'gm',
          password: 'secret',
        });

      const connecting = connected.connect();
      // connect() awaits authentication before attaching the handshake
      // listeners, so wait for the 'session' listener before firing it.
      await vi.waitFor(() => expect(harness.listeners.get('session')?.length).toBe(1));
      harness.fire('session', { userId: 'test-user-id' });
      await connecting;

      return { client: connected, ...harness };
    }

    it('reports connected after a successful handshake', async () => {
      const { client: connected } = await connectWithMockSocket();
      expect(connected.isConnected()).toBe(true);
    });

    it('authenticates an explicitly empty password for a passwordless Foundry user', async () => {
      const { authenticateFoundry } = await import('../auth.js');
      const { client: connected } = await connectWithMockSocket(
        new FoundryClient({ baseUrl: 'http://localhost:30000', username: 'gm', password: '' }),
      );

      expect(authenticateFoundry).toHaveBeenCalledWith('http://localhost:30000', 'gm', '');
      expect(connected.isConnected()).toBe(true);
      await connected.disconnect();
    });

    it('reports disconnected once the socket drops without disconnect()', async () => {
      const { client: connected, socket, fire } = await connectWithMockSocket();

      // Simulate the server going away: Socket.IO flips `connected` and emits
      // 'disconnect'. `disconnect()` is deliberately NOT called.
      socket.connected = false;
      fire('disconnect', 'transport close');

      expect(connected.isConnected()).toBe(false);
    });

    it('reports disconnected on a silent drop even without a disconnect event', async () => {
      const { client: connected, socket } = await connectWithMockSocket();
      socket.connected = false;
      expect(connected.isConnected()).toBe(false);
    });

    it('get_health_status reports the dropped socket', async () => {
      const { handleGetHealthStatus } = await import('../../tools/handlers/diagnostics.js');
      const { client: connected, socket, fire } = await connectWithMockSocket();
      const diagnosticsClient = {
        getSystemHealth: vi.fn().mockRejectedValue(new Error('no REST module')),
      };

      const before = await handleGetHealthStatus(
        {},
        connected,
        diagnosticsClient as unknown as Parameters<typeof handleGetHealthStatus>[2],
      );
      expect((before.content[0] as { text: string }).text).toContain('✅ Connected');

      socket.connected = false;
      fire('disconnect', 'transport close');

      const after = await handleGetHealthStatus(
        {},
        connected,
        diagnosticsClient as unknown as Parameters<typeof handleGetHealthStatus>[2],
      );
      expect((after.content[0] as { text: string }).text).toContain('❌ Disconnected');
    });

    it('marks the cached world data stale after a drop, but keeps serving it', async () => {
      const { client: connected, socket, fire } = await connectWithMockSocket();
      expect(connected.isWorldDataStale()).toBe(false);

      socket.connected = false;
      fire('disconnect', 'transport close');

      expect(connected.isWorldDataStale()).toBe(true);
      // The snapshot is retained — a stale answer beats no answer.
      expect(connected.hasWorldData()).toBe(true);
      expect(connected.getUsers().users).toHaveLength(2);
    });

    /**
     * socket.io-client reconnects with `reconnection: true` by default and
     * `sessionSocketOptions` does not turn it off, so after a transient drop
     * the manager brings the SAME socket back up and re-emits 'connect'.
     * Liveness has to follow it back up, not latch off for the rest of the
     * process while broadcasts and writes are working again.
     */
    it('reports connected again when the socket auto-reconnects', async () => {
      const { client: connected, socket, fire } = await connectWithMockSocket();

      socket.connected = false;
      fire('disconnect', 'transport close');
      expect(connected.isConnected()).toBe(false);

      // What socket.io does on an automatic reconnect of the same instance.
      socket.connected = true;
      fire('connect');

      expect(connected.isConnected()).toBe(true);
      await vi.waitFor(() => expect(connected.isWorldDataStale()).toBe(false));
    });

    /**
     * And the flag has to reach a human. A reconnected client that reports
     * "✅ Connected" while serving a cache that missed every broadcast from the
     * outage is the sharper version of #217's second impact bullet.
     */
    it('get_health_status marks the cache stale after a drop and a reconnect', async () => {
      const { handleGetHealthStatus } = await import('../../tools/handlers/diagnostics.js');
      const { client: connected, socket, fire } = await connectWithMockSocket();
      const diagnosticsClient = {
        getSystemHealth: vi.fn().mockRejectedValue(new Error('no REST module')),
      } as unknown as Parameters<typeof handleGetHealthStatus>[2];

      const before = await handleGetHealthStatus({}, connected, diagnosticsClient);
      expect((before.content[0] as { text: string }).text).not.toMatch(/stale/i);

      socket.connected = false;
      fire('disconnect', 'transport close');
      socket.connected = true;
      fire('connect');
      await vi.waitFor(() => expect(connected.isWorldDataStale()).toBe(false));

      const after = (await handleGetHealthStatus({}, connected, diagnosticsClient)).content[0] as {
        text: string;
      };

      expect(after.text).toContain('✅ Connected');
      expect(after.text).not.toMatch(/stale/i);
    });

    it('removes the persistent connect listener on explicit disconnect()', async () => {
      const { client: connected, socket, listeners } = await connectWithMockSocket();

      const registered = socket.on.mock.calls
        .filter(([event]) => event === 'connect')
        .map(([, handler]) => handler);
      expect(registered).toHaveLength(1);

      await connected.disconnect();

      expect(socket.off).toHaveBeenCalledWith('connect', registered[0]);
      expect(listeners.get('connect') ?? []).toHaveLength(0);
    });

    /**
     * `DiagnosticsClient.testAuthentication()` calls `connect()` on a client
     * that is already connected. The superseded socket used to keep the same
     * bound 'disconnect' handler, so when it closed it cleared liveness for the
     * live socket that had replaced it.
     */
    it('a superseded socket cannot clear liveness for its replacement', async () => {
      const first = await connectWithMockSocket();
      const second = await connectWithMockSocket(first.client);
      expect(second.socket).not.toBe(first.socket);
      expect(first.client.isConnected()).toBe(true);

      // The orphaned socket finally closes.
      first.socket.connected = false;
      first.fire('disconnect', 'transport close');

      expect(first.client.isConnected()).toBe(true);
      expect(first.client.isWorldDataStale()).toBe(false);
    });

    it('removes the persistent disconnect listener on explicit disconnect()', async () => {
      const { client: connected, socket, listeners } = await connectWithMockSocket();

      const registered = socket.on.mock.calls
        .filter(([event]) => event === 'disconnect')
        .map(([, handler]) => handler);
      expect(registered).toHaveLength(1);

      await connected.disconnect();

      expect(socket.off).toHaveBeenCalledWith('disconnect', registered[0]);
      expect(listeners.get('disconnect') ?? []).toHaveLength(0);
    });

    /**
     * Issue #218 — presence used to be frozen at the world snapshot: nothing
     * subscribed to `userActivity`, and `modifyDocument` maps onto document
     * collections, never the top-level `activeUsers` field.
     */
    it('applies a userActivity login to the cache and to get_users', async () => {
      const { handleGetUsers } = await import('../../tools/handlers/users.js');
      const { client: connected, fire } = await connectWithMockSocket();

      expect(connected.getUsers().activeUsers).toEqual(['user-aaaaaaaaaaaaaa']);
      const before = await handleGetUsers({}, connected);
      expect((before.content[0] as { text: string }).text).toContain('(1/2 online)');

      fire('userActivity', 'user-bbbbbbbbbbbbbb', { active: true });

      expect(connected.getUsers().activeUsers).toEqual([
        'user-aaaaaaaaaaaaaa',
        'user-bbbbbbbbbbbbbb',
      ]);
      const after = await handleGetUsers({}, connected);
      const text = (after.content[0] as { text: string }).text;
      expect(text).toContain('(2/2 online)');
      expect(text).toContain('**Player** (Player) — Online');
    });

    it('applies a userActivity logout to the cache and to get_users', async () => {
      const { handleGetUsers } = await import('../../tools/handlers/users.js');
      const { client: connected, fire } = await connectWithMockSocket();

      fire('userActivity', 'user-aaaaaaaaaaaaaa', { active: false });

      expect(connected.getUsers().activeUsers).toEqual([]);
      const after = await handleGetUsers({}, connected);
      const text = (after.content[0] as { text: string }).text;
      expect(text).toContain('(0/2 online)');
      expect(text).toContain('**GM** (Game Master) — Offline');
    });

    it('ignores a malformed userActivity payload rather than corrupting the cache', async () => {
      const { client: connected, fire } = await connectWithMockSocket();

      fire('userActivity', 42, { active: false });
      fire('userActivity', 'user-bbbbbbbbbbbbbb', { active: 'yes' });

      expect(connected.getUsers().activeUsers).toEqual(['user-aaaaaaaaaaaaaa']);
    });

    it('removes the userActivity listener on disconnect()', async () => {
      const { client: connected, socket, listeners } = await connectWithMockSocket();

      const registered = socket.on.mock.calls
        .filter(([event]) => event === 'userActivity')
        .map(([, handler]) => handler);
      expect(registered).toHaveLength(1);

      await connected.disconnect();

      expect(socket.off).toHaveBeenCalledWith('userActivity', registered[0]);
      expect(listeners.get('userActivity') ?? []).toHaveLength(0);
    });

    /**
     * REST mode has no socket to consult, so the socket clause must not apply
     * to it. Its own liveness signal — the last observed request outcome — is
     * covered in "liveness after the connect probe" above.
     */
    it('does not require a socket in REST API mode', async () => {
      const restClient = new FoundryClient({
        baseUrl: 'http://localhost:30000',
        apiKey: 'test-api-key',
      });
      mockAxiosInstance.get.mockResolvedValue({ status: 200, data: {} });

      await restClient.connect();
      expect(restClient.isConnected()).toBe(true);
    });
  });
});
