import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrustedCallerContext } from '../caller-context.js';
import type { WorldActor, WorldData, WorldMessage, WorldUser } from '../types.js';

vi.mock('axios');
vi.mock('socket.io-client');
vi.mock('../auth.js', () => ({
  authenticateFoundry: vi.fn(),
  sessionSocketOptions: vi.fn(),
}));
vi.mock('../../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock('../../config/index.js', () => ({ config: { logLevel: 'info' } }));

const { FoundryClient } = await import('../client.js');

const SERVICE = 'Service000000001';
const PLAYER_ONE = 'Player000000001';
const PLAYER_TWO = 'Player000000002';
const GM = 'Gamemaster0000001';
const WORLD = 'world-one';

type Listener = (...args: unknown[]) => void;

function buildMockSocket() {
  const listeners = new Map<string, Set<Listener>>();
  const worldAcks: Array<(value: unknown) => void> = [];
  const socket = {
    connected: true,
    on: vi.fn((event: string, listener: Listener) => {
      const eventListeners = listeners.get(event) ?? new Set<Listener>();
      eventListeners.add(listener);
      listeners.set(event, eventListeners);
      return socket;
    }),
    off: vi.fn((event: string, listener: Listener) => {
      listeners.get(event)?.delete(listener);
      return socket;
    }),
    emit: vi.fn((event: string, ...args: unknown[]) => {
      const ack = args.at(-1);
      if (event === 'world' && typeof ack === 'function') {
        worldAcks.push(ack as (value: unknown) => void);
      }
      return socket;
    }),
    disconnect: vi.fn(() => {
      socket.connected = false;
    }),
  };
  return { socket, worldAcks };
}

function user(_id: string, role = 1): WorldUser {
  return {
    _id,
    name: _id === GM ? 'GM' : _id === PLAYER_ONE ? 'Player One' : 'Player Two',
    role,
    color: '#123456',
    avatar: `${_id}.webp`,
    password: 'must-not-cross-boundary',
    flags: { secret: true },
  };
}

function actor(
  suffix: number,
  ownership: Record<string, number> | undefined,
  items?: WorldActor['items'],
): WorldActor {
  return {
    _id: `Actor${String(suffix).padStart(11, '0')}`,
    name: `Actor ${suffix}`,
    type: 'character',
    system: { hp: suffix },
    ownership,
    items,
  };
}

function message(
  suffix: number,
  author: string,
  options: Partial<WorldMessage> = {},
): WorldMessage {
  return {
    _id: `Message${String(suffix).padStart(9, '0')}`,
    type: 0,
    author,
    user: SERVICE,
    timestamp: suffix,
    content: `message ${suffix}`,
    ...options,
  };
}

function snapshot(overrides: Partial<WorldData> = {}): WorldData {
  return {
    userId: SERVICE,
    release: { version: '14.369' },
    world: { id: WORLD, title: 'Test World' },
    system: { id: 'dnd5e' },
    modules: [],
    demoMode: false,
    actors: [],
    scenes: [],
    items: [],
    journal: [],
    messages: [],
    combats: [],
    users: [user(SERVICE, 4), user(PLAYER_ONE), user(PLAYER_TWO), user(GM, 3)],
    activeUsers: [SERVICE, PLAYER_ONE, PLAYER_TWO, GM],
    settings: [],
    folders: [],
    macros: [],
    playlists: [],
    tables: [],
    cards: [],
    packs: [],
    ...overrides,
  };
}

function context(overrides: Partial<TrustedCallerContext> = {}): TrustedCallerContext {
  return {
    callerId: 'transport-caller-one',
    userId: PLAYER_ONE,
    worldId: WORLD,
    sessionId: 'transport-session-one',
    ...overrides,
  };
}

function delegatedClient() {
  const client = new FoundryClient({
    baseUrl: 'http://localhost:30000',
    authorizationMode: 'delegated',
    timeout: 100,
    retryAttempts: 0,
  });
  const mock = buildMockSocket();
  Reflect.set(client, 'socket', mock.socket);
  Reflect.set(client, 'socketGeneration', 1);
  Reflect.set(client, 'socketEpoch', 1);
  Reflect.set(client, 'socketUserId', SERVICE);
  Reflect.set(client, '_isConnected', true);
  return { client, mock };
}

async function runAuthorized<T>(
  client: InstanceType<typeof FoundryClient>,
  mock: ReturnType<typeof buildMockSocket>,
  caller: TrustedCallerContext,
  value: WorldData,
  operation: () => Promise<T> | T,
): Promise<T> {
  const index = mock.worldAcks.length;
  const pending = client.runWithCaller(caller, operation);
  expect(mock.worldAcks).toHaveLength(index + 1);
  mock.worldAcks[index]?.(structuredClone(value));
  return await pending;
}

beforeEach(() => {
  vi.mocked(axios).create = vi.fn().mockReturnValue({
    interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
  });
});

describe('delegated caller authorization', () => {
  it('preserves service-identity reads as the compatibility default', () => {
    const client = new FoundryClient({ baseUrl: 'http://localhost:30000' });
    const raw = snapshot({ actors: [actor(1, { default: 0 })] });
    Reflect.set(client, 'worldData', raw);

    expect(client.isDelegatedMode()).toBe(false);
    expect(client.getWorldData()).toBe(raw);
    expect(client.getWorldSummary().actors).toBe(1);
  });

  it('requires a fresh connected socket snapshot and a well-formed trusted context', async () => {
    const { client, mock } = delegatedClient();

    expect(() => client.getWorldData()).toThrow('Caller is not authorized');
    await expect(
      client.runWithCaller({ ...context(), sessionId: '' }, () => client.getWorldData()),
    ).rejects.toThrow('Caller is not authorized');
    expect(mock.worldAcks).toHaveLength(0);

    await expect(
      runAuthorized(client, mock, context({ worldId: 'other-world' }), snapshot(), () =>
        client.getWorldData(),
      ),
    ).rejects.toThrow('Caller is not authorized');

    mock.socket.connected = false;
    await expect(client.runWithCaller(context(), () => client.getWorldData())).rejects.toThrow(
      'Caller is not authorized',
    );
  });

  it('fails closed for unknown, banned, duplicate, and malformed caller identities', async () => {
    const cases: Array<[TrustedCallerContext, WorldData]> = [
      [context({ userId: 'Unknown000000001' }), snapshot()],
      [context(), snapshot({ users: [user(SERVICE, 4), user(PLAYER_ONE, 0)] })],
      [context(), snapshot({ users: [user(SERVICE, 4), user(PLAYER_ONE), user(PLAYER_ONE)] })],
      [context(), snapshot({ users: [user(SERVICE, 4), { ...user(PLAYER_ONE), role: 5 }] })],
      [
        context(),
        snapshot({ users: [user(SERVICE, 4), { ...user(PLAYER_ONE), color: undefined as never }] }),
      ],
    ];

    for (const [caller, value] of cases) {
      const { client, mock } = delegatedClient();
      await expect(
        runAuthorized(client, mock, caller, value, () => client.getWorldData()),
      ).rejects.toThrow('Caller is not authorized');
    }
  });

  it('applies explicit, default, inherited, embedded, and journal page permissions', async () => {
    const { client, mock } = delegatedClient();
    const visibleParentItems = [
      {
        _id: 'Item000000000001',
        name: 'Inherited',
        type: 'loot',
        system: {},
        ownership: { default: -1 },
      },
      {
        _id: 'Item000000000002',
        name: 'Limited',
        type: 'loot',
        system: {},
        ownership: { [PLAYER_ONE]: 1 },
      },
      {
        _id: 'Item000000000003',
        name: 'Malformed',
        type: 'loot',
        system: {},
        ownership: { default: 9 },
      },
    ];
    const value = snapshot({
      actors: [
        actor(1, { [PLAYER_ONE]: 2 }),
        actor(2, { default: 2 }, visibleParentItems),
        actor(3, { default: 1 }),
        actor(4, undefined),
        actor(5, { default: 2, somebody: 9 }),
      ],
      items: [
        {
          _id: 'Item000000000004',
          name: 'Visible',
          type: 'loot',
          system: {},
          ownership: { default: 2 },
        },
        {
          _id: 'Item000000000005',
          name: 'Limited',
          type: 'loot',
          system: {},
          ownership: { [PLAYER_ONE]: 1, default: 3 },
        },
      ],
      journal: [
        {
          _id: 'Journal000000001',
          name: 'Visible Journal',
          ownership: { default: 2 },
          pages: [
            {
              _id: 'JPage00000000001',
              name: 'Inherited',
              type: 'text',
              ownership: { default: -1 },
            },
            {
              _id: 'JPage00000000002',
              name: 'Limited',
              type: 'text',
              ownership: { [PLAYER_ONE]: 1 },
            },
            { _id: 'JPage00000000003', name: 'Malformed', type: 'text', ownership: { default: 8 } },
          ],
        },
        { _id: 'Journal000000002', name: 'Hidden Journal', ownership: { default: 1 } },
      ],
    });

    const view = await runAuthorized(client, mock, context(), value, () => client.getWorldData());
    expect(view?.actors.map((entry) => entry._id)).toEqual([
      'Actor00000000001',
      'Actor00000000002',
    ]);
    expect(view?.actors[1]?.items?.map((entry) => entry._id)).toEqual(['Item000000000001']);
    expect(view?.items.map((entry) => entry._id)).toEqual(['Item000000000004']);
    expect(view?.journal.map((entry) => entry._id)).toEqual(['Journal000000001']);
    expect(view?.journal[0]?.pages?.map((entry) => entry._id)).toEqual(['JPage00000000001']);

    const gm = delegatedClient();
    const gmView = await runAuthorized(gm.client, gm.mock, context({ userId: GM }), value, () =>
      gm.client.getWorldData(),
    );
    expect(gmView?.actors.map((entry) => entry._id)).not.toContain('Actor00000000004');
  });

  it('does not give GMs a blanket whisper override and honors blind messages', async () => {
    const value = snapshot({
      messages: [
        message(1, PLAYER_TWO),
        message(2, PLAYER_TWO, { whisper: [PLAYER_ONE] }),
        message(3, PLAYER_TWO, { whisper: [PLAYER_TWO] }),
        message(4, PLAYER_ONE, { whisper: [PLAYER_TWO] }),
        message(5, PLAYER_ONE, { whisper: [PLAYER_TWO], blind: true }),
        message(6, PLAYER_TWO, { whisper: [PLAYER_ONE], blind: true }),
        message(7, PLAYER_TWO, { whisper: [''] }),
        message(8, GM, { whisper: [PLAYER_TWO], blind: true }),
      ],
    });
    const player = delegatedClient();
    const playerMessages = await runAuthorized(player.client, player.mock, context(), value, () =>
      player.client.getChatMessages(),
    );
    expect(playerMessages.map((entry) => entry._id)).toEqual([
      'Message000000001',
      'Message000000002',
      'Message000000004',
      'Message000000006',
    ]);

    const gm = delegatedClient();
    const gmMessages = await runAuthorized(gm.client, gm.mock, context({ userId: GM }), value, () =>
      gm.client.getChatMessages(),
    );
    expect(gmMessages.map((entry) => entry._id)).toEqual(['Message000000001', 'Message000000008']);
  });

  it('returns sanitized caller state and authorized summary counts', async () => {
    const { client, mock } = delegatedClient();
    const hiddenCharacter = actor(2, { default: 1 });
    const value = snapshot({
      actors: [actor(1, { default: 2 }), hiddenCharacter],
      scenes: [{ _id: 'Scene00000000001' } as never],
      messages: [message(1, PLAYER_ONE)],
      macros: [{ _id: 'Macro00000000001' }],
      users: [
        user(SERVICE, 4),
        { ...user(PLAYER_ONE), character: hiddenCharacter._id },
        user(PLAYER_TWO),
        user(GM, 3),
      ],
    });
    const result = await runAuthorized(client, mock, context(), value, async () => ({
      world: await client.getWorldInfo(),
      users: client.getUsers(),
      summary: client.getWorldSummary(),
      metadata: client.getReadMetadata(),
    }));

    expect(result.users).toEqual({
      users: [
        {
          _id: PLAYER_ONE,
          name: 'Player One',
          role: 1,
          color: '#123456',
          avatar: `${PLAYER_ONE}.webp`,
        },
      ],
      activeUsers: [PLAYER_ONE],
    });
    expect(result.world).toMatchObject({
      id: WORLD,
      title: 'Test World',
      created: result.metadata.capturedAt,
      modified: result.metadata.observedAt,
    });
    expect(result.summary).toEqual({ actors: 1, items: 0, journals: 0, users: 1, messages: 1 });
    expect(result.metadata).toMatchObject({
      source: 'socket',
      freshness: 'current',
      worldId: WORLD,
      sessionId: 'transport-session-one',
      revision: 1,
    });
    expect(result.metadata.snapshotId).toMatch(/^[a-f0-9]{64}$/);
  });

  it('isolates concurrent callers and freezes projections without mutating the raw snapshot', async () => {
    const { client, mock } = delegatedClient();
    const value = snapshot({
      actors: [
        actor(1, { [PLAYER_ONE]: 2, [PLAYER_TWO]: 0 }),
        actor(2, { [PLAYER_ONE]: 0, [PLAYER_TWO]: 2 }),
      ],
    });

    const first = client.runWithCaller(context(), async () => {
      await Promise.resolve();
      return client.getWorldData();
    });
    const second = client.runWithCaller(
      context({
        callerId: 'transport-caller-two',
        userId: PLAYER_TWO,
        sessionId: 'transport-session-two',
      }),
      async () => {
        await Promise.resolve();
        return client.getWorldData();
      },
    );
    expect(mock.worldAcks).toHaveLength(2);
    mock.worldAcks[0]?.(structuredClone(value));
    mock.worldAcks[1]?.(structuredClone(value));
    const [firstView, secondView] = await Promise.all([first, second]);

    expect(firstView?.actors.map((entry) => entry._id)).toEqual(['Actor00000000001']);
    expect(secondView?.actors.map((entry) => entry._id)).toEqual(['Actor00000000002']);
    expect(Object.isFrozen(firstView)).toBe(true);
    expect(Object.isFrozen(firstView?.actors)).toBe(true);
    expect(() => firstView?.actors.push(actor(3, { default: 2 }))).toThrow();
    expect(value.actors).toHaveLength(2);
  });

  it('denies unsupported surfaces and writes while preserving operation validation errors', async () => {
    const { client, mock } = delegatedClient();
    await runAuthorized(client, mock, context(), snapshot(), async () => {
      expect(() => client.assertReadSurfaceAllowed('scenes')).toThrow('Caller is not authorized');
      expect(() => client.getScenes()).toThrow('Caller is not authorized');
      await expect(client.rollDice('1d20')).rejects.toThrow('Caller is not authorized');
      await expect(client.refreshWorldData()).rejects.toThrow('Caller is not authorized');
    });

    const expected = new McpError(ErrorCode.InvalidParams, 'safe validation detail');
    await expect(
      runAuthorized(client, mock, context(), snapshot(), () => {
        throw expected;
      }),
    ).rejects.toBe(expected);
  });

  it('binds pagination to caller, session, world, and the full authorized view', async () => {
    const { client, mock } = delegatedClient();
    const value = snapshot({ actors: [actor(1, { default: 2 }), actor(2, { default: 2 })] });
    const first = await runAuthorized(client, mock, context(), value, () =>
      client.searchActors({ limit: 1 }),
    );
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await runAuthorized(client, mock, context(), value, () =>
      client.searchActors({ limit: 1, cursor: first.nextCursor ?? undefined }),
    );
    expect(second.actors).toHaveLength(1);

    await expect(
      runAuthorized(client, mock, context({ sessionId: 'transport-session-other' }), value, () =>
        client.searchActors({ limit: 1, cursor: first.nextCursor ?? undefined }),
      ),
    ).rejects.toThrow('Pagination cursor does not match');

    const changedView = snapshot({
      actors: [actor(1, { default: 2 }), actor(2, { default: 2 }), actor(3, { default: 2 })],
    });
    await expect(
      runAuthorized(client, mock, context(), changedView, () =>
        client.searchActors({ limit: 1, cursor: first.nextCursor ?? undefined }),
      ),
    ).rejects.toThrow('Pagination cursor does not match');
  });
});
