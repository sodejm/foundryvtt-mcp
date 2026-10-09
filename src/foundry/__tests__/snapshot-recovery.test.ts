import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorldData } from '../types.js';

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

const USER_ONE = 'User000000000001';
const USER_TWO = 'User000000000002';
const ACTOR_ONE = 'Actor00000000001';
const ACTOR_TWO = 'Actor00000000002';

type Listener = (...args: unknown[]) => void;

function buildMockSocket() {
  const listeners = new Map<string, Set<Listener>>();
  const worldAcks: Array<(value: unknown) => void> = [];
  const modifyAcks: Array<(value: unknown) => void> = [];
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
      if (typeof ack === 'function') {
        if (event === 'world') {
          worldAcks.push(ack as (value: unknown) => void);
        } else if (event === 'modifyDocument') {
          modifyAcks.push(ack as (value: unknown) => void);
        }
      }
      return socket;
    }),
    disconnect: vi.fn(() => {
      socket.connected = false;
    }),
  };

  return {
    socket,
    worldAcks,
    modifyAcks,
    fire(event: string, ...args: unknown[]) {
      for (const listener of [...(listeners.get(event) ?? [])]) {
        listener(...args);
      }
    },
  };
}

function snapshot(userId = USER_ONE, worldId = 'world-one'): WorldData {
  return {
    userId,
    release: {},
    world: { id: worldId, title: 'Test World' },
    system: { id: 'dnd5e' },
    modules: [],
    demoMode: false,
    actors: [
      { _id: ACTOR_ONE, name: 'Alpha', type: 'character', system: { attributes: {} } },
      { _id: ACTOR_TWO, name: 'Beta', type: 'npc', system: { attributes: {} } },
    ],
    scenes: [],
    items: [],
    journal: [],
    messages: [],
    combats: [],
    users: [{ _id: userId, name: 'GM', role: 4, active: true }],
    activeUsers: [userId],
    settings: [],
    folders: [],
    macros: [],
    playlists: [],
    tables: [],
    cards: [],
    packs: [],
  };
}

function callPrivate<T>(client: object, name: string, ...args: unknown[]): T {
  return Reflect.get(client, name).call(client, ...args) as T;
}

function attachClient(
  client: InstanceType<typeof FoundryClient>,
  mock: ReturnType<typeof buildMockSocket>,
  userId = USER_ONE,
) {
  Reflect.set(client, 'socket', mock.socket);
  Reflect.set(client, 'socketGeneration', 1);
  Reflect.set(client, 'socketEpoch', 1);
  Reflect.set(client, 'socketUserId', userId);
  Reflect.set(client, '_isConnected', true);
  callPrivate(client, 'attachSocketListeners', mock.socket);
}

async function loadSnapshot(
  client: InstanceType<typeof FoundryClient>,
  mock: ReturnType<typeof buildMockSocket>,
  value = snapshot(),
) {
  const refresh = client.refreshWorldData();
  expect(mock.worldAcks).toHaveLength(1);
  mock.worldAcks[0]?.(structuredClone(value));
  await refresh;
}

describe('FoundryClient snapshot recovery lifecycle', () => {
  let mockAxiosInstance: {
    interceptors: {
      request: { use: ReturnType<typeof vi.fn> };
      response: { use: ReturnType<typeof vi.fn> };
    };
  };

  beforeEach(() => {
    mockAxiosInstance = {
      interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
    };
    vi.mocked(axios).create = vi.fn().mockReturnValue(mockAxiosInstance);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('retries an invalid identity after the configured delay and publishes only the valid ACK', async () => {
    vi.useFakeTimers();
    const client = new FoundryClient({
      baseUrl: 'http://localhost:30000',
      timeout: 100,
      retryAttempts: 1,
      retryDelay: 5,
    });
    const mock = buildMockSocket();
    attachClient(client, mock);

    const refresh = client.refreshWorldData();
    mock.worldAcks[0]?.(snapshot(USER_TWO));
    await vi.advanceTimersByTimeAsync(5);

    expect(mock.worldAcks).toHaveLength(2);
    mock.worldAcks[1]?.(snapshot());
    await refresh;

    expect(client.getReadMetadata()).toMatchObject({
      freshness: 'current',
      worldId: 'world-one',
      revision: 1,
    });
  });

  it('stops futile retries after event-buffer overflow and recovers on a fresh refresh', async () => {
    const client = new FoundryClient({
      baseUrl: 'http://localhost:30000',
      timeout: 100,
      retryAttempts: 3,
      retryDelay: 0,
    });
    const mock = buildMockSocket();
    attachClient(client, mock);
    await loadSnapshot(client, mock);

    const refresh = client.refreshWorldData();
    const rejected = expect(refresh).rejects.toThrow(/buffer overflowed/);
    for (let index = 0; index <= 1_000; index += 1) {
      callPrivate(client, 'onDocumentBroadcast', {
        type: 'Actor',
        action: 'update',
        result: [{ _id: 'ActorMissing0001', name: `Event ${index}` }],
      });
    }
    mock.worldAcks[1]?.(snapshot());

    await rejected;
    expect(mock.worldAcks).toHaveLength(2);
    expect(client.getReadMetadata()).toMatchObject({ freshness: 'stale', revision: 1 });

    const recovery = client.refreshWorldData();
    expect(mock.worldAcks).toHaveLength(3);
    mock.worldAcks[2]?.(snapshot());
    await recovery;
    expect(client.getReadMetadata()).toMatchObject({ freshness: 'current', revision: 2 });
  });

  it('invalidates snapshot cursors and reloads when the authenticated session changes', async () => {
    const client = new FoundryClient({
      baseUrl: 'http://localhost:30000',
      timeout: 100,
      retryAttempts: 0,
    });
    const mock = buildMockSocket();
    attachClient(client, mock);
    await loadSnapshot(client, mock);
    const firstSession = client.getReadMetadata().sessionId;
    const firstPage = await client.searchActors({ limit: 1 });
    expect(firstPage.nextCursor).toBeTruthy();

    mock.fire('session', { userId: USER_ONE });
    mock.fire('session', null);
    expect(mock.worldAcks).toHaveLength(1);

    mock.fire('session', { userId: USER_TWO });
    expect(client.getReadMetadata()).toMatchObject({ freshness: 'unavailable', revision: 0 });
    expect(client.getReadMetadata().sessionId).not.toBe(firstSession);
    expect(mock.worldAcks).toHaveLength(2);

    mock.worldAcks[1]?.(snapshot(USER_TWO));
    await vi.waitFor(() => expect(client.getReadMetadata().freshness).toBe('current'));
    await expect(
      client.searchActors({ cursor: firstPage.nextCursor ?? undefined }),
    ).rejects.toThrow(/no longer available/);
  });

  it('rejects a pending refresh across reconnect and ignores its retired ACK', async () => {
    const client = new FoundryClient({
      baseUrl: 'http://localhost:30000',
      timeout: 100,
      retryAttempts: 0,
    });
    const mock = buildMockSocket();
    attachClient(client, mock);
    await loadSnapshot(client, mock);

    const pending = client.refreshWorldData();
    const rejected = expect(pending).rejects.toThrow(/disconnected/);
    const retiredAck = mock.worldAcks[1];
    mock.socket.connected = false;
    mock.fire('disconnect', 'transport close');
    await rejected;
    expect(client.getReadMetadata()).toMatchObject({ freshness: 'stale', revision: 1 });

    mock.socket.connected = true;
    mock.fire('connect');
    expect(mock.worldAcks).toHaveLength(3);
    retiredAck?.(snapshot(USER_ONE, 'retired-world'));
    mock.worldAcks[2]?.(snapshot(USER_ONE, 'world-one'));
    await vi.waitFor(() => expect(client.getReadMetadata().freshness).toBe('current'));

    expect(client.getReadMetadata()).toMatchObject({ worldId: 'world-one', revision: 2 });
  });

  it('waits for reconnect before reloading a changed session', async () => {
    const client = new FoundryClient({
      baseUrl: 'http://localhost:30000',
      timeout: 100,
      retryAttempts: 0,
    });
    const mock = buildMockSocket();
    attachClient(client, mock);
    await loadSnapshot(client, mock);

    mock.socket.connected = false;
    mock.fire('disconnect', 'transport close');
    mock.fire('session', { userId: USER_TWO });

    expect(client.getReadMetadata()).toMatchObject({ freshness: 'unavailable', revision: 0 });
    expect(mock.worldAcks).toHaveLength(1);
    await expect(client.refreshWorldData()).rejects.toThrow(/Not connected/);

    mock.socket.connected = true;
    mock.fire('connect');
    expect(mock.worldAcks).toHaveLength(2);
    mock.worldAcks[1]?.(snapshot(USER_TWO));
    await vi.waitFor(() => expect(client.getReadMetadata().freshness).toBe('current'));

    expect(client.getReadMetadata()).toMatchObject({ worldId: 'world-one', revision: 1 });
  });

  it('rotates the read session and invalidates cursors when a refresh changes worlds', async () => {
    const client = new FoundryClient({
      baseUrl: 'http://localhost:30000',
      timeout: 100,
      retryAttempts: 0,
    });
    const mock = buildMockSocket();
    attachClient(client, mock);
    await loadSnapshot(client, mock);
    const oldMetadata = client.getReadMetadata();
    const firstPage = await client.searchActors({ limit: 1 });

    const refresh = client.refreshWorldData();
    mock.worldAcks[1]?.(snapshot(USER_ONE, 'world-two'));
    await refresh;

    expect(client.getReadMetadata()).toMatchObject({ worldId: 'world-two', revision: 1 });
    expect(client.getReadMetadata().sessionId).not.toBe(oldMetadata.sessionId);
    await expect(
      client.searchActors({ cursor: firstPage.nextCursor ?? undefined }),
    ).rejects.toThrow(/no longer available/);
  });

  it('does not apply a write ACK to cache after the socket epoch changes', async () => {
    const client = new FoundryClient({
      baseUrl: 'http://localhost:30000',
      timeout: 100,
      retryAttempts: 0,
      writeEnabled: true,
    });
    const mock = buildMockSocket();
    attachClient(client, mock);
    await loadSnapshot(client, mock);

    const update = callPrivate<Promise<unknown[]>>(client, 'modifyDocument', 'Actor', 'update', {
      updates: [{ _id: ACTOR_ONE, name: 'Changed' }],
    });
    expect(mock.modifyAcks).toHaveLength(1);
    mock.socket.connected = false;
    mock.fire('disconnect', 'transport close');
    mock.modifyAcks[0]?.({ result: [{ _id: ACTOR_ONE, name: 'Changed' }] });

    await expect(update).resolves.toEqual([{ _id: ACTOR_ONE, name: 'Changed' }]);
    expect(client.getWorldData()?.actors[0]?.name).toBe('Alpha');
    expect(client.getReadMetadata()).toMatchObject({ freshness: 'stale', revision: 1 });
  });
});
