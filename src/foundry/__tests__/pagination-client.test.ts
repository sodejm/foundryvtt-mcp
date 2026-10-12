import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiagnosticsClient } from '../../diagnostics/client.js';
import { handleReadResource } from '../../tools/handlers/resources.js';
import { handleGetUsers } from '../../tools/handlers/users.js';
import {
  CONTENT_GENERATION_UNAVAILABLE,
  DIAGNOSTICS_UNAVAILABLE,
  RULES_LOOKUP_UNAVAILABLE,
} from '../capabilities.js';
import { FoundryClient } from '../client.js';
import type { WorldData } from '../types.js';

vi.mock('axios');
vi.mock('../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let get: ReturnType<typeof vi.fn>;

function id(prefix: string, index: number) {
  return `${prefix}${String(index).padStart(15, '0')}`;
}

function requireCursor(cursor: string | null): string {
  if (!cursor) {
    throw new Error('expected a pagination cursor');
  }
  return cursor;
}

function socketClient(role = 4) {
  const client = new FoundryClient({
    allowPrivilegedAccount: true,
    baseUrl: 'http://localhost:30000',
  });
  const actors = Array.from({ length: 101 }, (_, index) => ({
    _id: id('A', index),
    name: `Actor ${String(index).padStart(3, '0')}`,
    type: index % 2 ? 'npc' : 'character',
    system: {},
  }));
  const items = [
    { _id: id('I', 1), name: 'Twin', type: 'weapon', system: { rarities: ['rare'] } },
    { _id: id('I', 2), name: 'Twin', type: 'loot', system: { rarities: ['common'] } },
  ];
  const world: WorldData = {
    userId: id('U', 1),
    release: {},
    world: { id: 'world-1', title: 'World' },
    system: { id: 'dnd5e', version: '6.0.6' },
    modules: [],
    demoMode: false,
    actors,
    items,
    scenes: [{ _id: id('S', 1), name: 'Twin', active: true }],
    journal: [
      { _id: id('J', 1), name: 'Twin', pages: [{ _id: id('P', 1), name: 'Page', type: 'text' }] },
    ],
    users: [
      { _id: id('U', 1), name: 'GM', role, color: '#000' },
      { _id: id('U', 2), name: 'Other GM', role: 4, color: '#111' },
    ],
    messages: [],
    combats: [],
    activeUsers: [id('U', 1)],
    settings: [],
    folders: [],
    macros: [],
    playlists: [],
    tables: [],
    cards: [],
    packs: [],
  };
  Reflect.set(client, 'worldData', world);
  Reflect.set(client, 'snapshotWorldId', world.world.id);
  Reflect.set(client, 'snapshotId', 'world-snapshot-1');
  Reflect.set(client, 'snapshotRevision', 1);
  Reflect.set(client, 'snapshotCapturedAt', '2026-01-01T00:00:00.000Z');
  Reflect.set(client, 'snapshotObservedAt', '2026-01-01T00:00:01.000Z');
  return { client, world };
}

function restClient() {
  return new FoundryClient({
    allowPrivilegedAccount: true,
    baseUrl: 'http://localhost:30000',
    apiKey: 'key',
    retryAttempts: 1,
    retryDelay: 1,
  });
}

beforeEach(() => {
  get = vi.fn();
  vi.mocked(axios.create).mockReturnValue({
    get,
    interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
  } as unknown as ReturnType<typeof axios.create>);
});

describe('socket snapshot pagination', () => {
  it('orders duplicate names by case-sensitive opaque actor and item IDs', async () => {
    const { client, world } = socketClient();
    const upper = 'AAAAAAAAAAAAAAAA';
    const lower = 'aAAAAAAAAAAAAAAA';
    for (const collection of [world.actors, world.items]) {
      const record = collection[0];
      if (!record) {
        throw new Error('Expected a seeded collection record');
      }
      collection.splice(
        0,
        collection.length,
        { ...record, _id: lower, name: 'Twin' },
        { ...record, _id: upper, name: 'Twin' },
      );
    }
    expect((await client.searchActors({})).actors.map((record) => record._id)).toEqual([
      upper,
      lower,
    ]);
    expect((await client.searchItems({})).items.map((record) => record._id)).toEqual([
      upper,
      lower,
    ]);
  });

  it('returns 101 actor IDs exactly once across immutable pages', async () => {
    const { client, world } = socketClient();
    const ids: string[] = [];
    let page = await client.searchActors({ limit: 17 });
    const cursor = requireCursor(page.nextCursor);
    world.actors[17].name = 'Mutated';
    for (;;) {
      ids.push(...page.actors.map((actor) => actor._id));
      if (!page.nextCursor) {
        break;
      }
      page = await client.searchActors({ cursor: page.nextCursor });
    }
    expect(ids).toHaveLength(101);
    expect(new Set(ids).size).toBe(101);
    expect((await client.searchActors({ cursor })).actors[0]?.name).toBe('Actor 017');
  });

  it('keeps the cursor source revision and marks it stale after a newer snapshot', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime('2026-01-01T00:00:04.000Z');
      const { client } = socketClient();
      const first = await client.searchActors({ limit: 1 });
      const sourceMetadata = first.readMetadata;

      Reflect.set(client, 'snapshotId', 'world-snapshot-2');
      Reflect.set(client, 'snapshotRevision', 2);
      Reflect.set(client, 'snapshotCapturedAt', '2026-01-01T00:00:02.000Z');
      Reflect.set(client, 'snapshotObservedAt', '2026-01-01T00:00:03.000Z');
      vi.setSystemTime('2026-01-01T00:00:05.000Z');
      const second = await client.searchActors({ cursor: requireCursor(first.nextCursor) });

      expect(second.snapshotId).toBe(first.snapshotId);
      expect(second.readMetadata).toMatchObject({
        snapshotId: sourceMetadata.snapshotId,
        revision: sourceMetadata.revision,
        capturedAt: sourceMetadata.capturedAt,
        observedAt: sourceMetadata.observedAt,
        freshness: 'stale',
        respondedAt: '2026-01-01T00:00:05.000Z',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies type and rarity filters without confusing duplicate names', async () => {
    const { client } = socketClient();
    const result = await client.searchItems({ query: 'Twin', type: 'weapon', rarity: 'rare' });
    expect(result.items.map((item) => item._id)).toEqual([id('I', 1)]);
    expect(result.total).toBe(1);
  });

  it('pages journal, world, and collection metadata only', async () => {
    const { client } = socketClient();
    await expect(client.searchJournalsPage({ query: 'Page' })).resolves.toMatchObject({
      records: [{ documentType: 'JournalEntry', pageCount: 1 }],
      total: 1,
    });
    const world = await client.searchWorldPage({ query: 'Twin', limit: 2 });
    expect(world.total).toBe(4);
    expect(world.records).toHaveLength(2);
    await expect(client.getCollectionPage('users', {})).resolves.toMatchObject({ total: 2 });
  });

  it('allows explicitly opted-in Assistant cached-world reads', async () => {
    const { client } = socketClient(3);
    await expect(client.searchActors({})).resolves.toMatchObject({ total: 101 });
    await expect(client.searchWorldPage({})).resolves.toMatchObject({ total: 105 });
  });

  it('binds the cursor to query, world, caller, and limit', async () => {
    const { client, world } = socketClient();
    const first = await client.searchActors({ query: 'Actor', limit: 1 });
    await expect(
      client.searchActors({ query: 'Other', cursor: requireCursor(first.nextCursor) }),
    ).rejects.toThrow(/query, world, or caller/);
    await expect(
      client.searchActors({
        query: 'Actor',
        limit: 2,
        cursor: requireCursor(first.nextCursor),
      }),
    ).rejects.toThrow(/limit/);
    world.world.id = 'world-2';
    await expect(
      client.searchActors({ query: 'Actor', cursor: requireCursor(first.nextCursor) }),
    ).rejects.toThrow(/query, world, or caller/);
    world.world.id = 'world-1';
    world.userId = id('U', 2);
    await expect(
      client.searchActors({ query: 'Actor', cursor: requireCursor(first.nextCursor) }),
    ).rejects.toThrow(/query, world, or caller/);
  });

  it('rejects oversized query and selectors before reading records', async () => {
    const { client } = socketClient();
    await expect(client.searchActors({ query: 'x'.repeat(1025) })).rejects.toThrow(
      /maximum length/,
    );
    await expect(client.searchItems({ type: 'x'.repeat(129) })).rejects.toThrow(/maximum length/);
  });
});

describe('users resource serialization', () => {
  async function readUsers(client: FoundryClient, uri = 'foundry://users') {
    const response = await handleReadResource(uri, client, {} as DiagnosticsClient);
    const text = response.contents[0].text;
    return { text, page: JSON.parse(text) };
  }

  function addPrivateFields(world: WorldData) {
    for (const user of world.users) {
      Object.assign(user, {
        password: 'PRIVATE_PASSWORD_MARKER',
        passwordHash: 'PRIVATE_HASH_MARKER',
        authentication: { token: 'PRIVATE_AUTH_MARKER' },
        flags: { module: { nested: ['PRIVATE_FLAG_MARKER'] } },
        futureField: { credential: 'PRIVATE_UNKNOWN_MARKER' },
        avatar: 'PRIVATE_AVATAR_MARKER',
        character: 'PRIVATE_CHARACTER_MARKER',
      });
    }
  }

  it('serializes only documented fields across immutable pages with private source fields', async () => {
    const { client, world } = socketClient();
    addPrivateFields(world);
    const first = await readUsers(client, 'foundry://users?limit=1');
    expect(first.page).toMatchObject({ schemaVersion: 3, collection: 'users', total: 2 });
    expect(first.page.records).toEqual([
      { id: id('U', 1), name: 'GM', documentType: 'User', active: true, role: 4 },
    ]);
    expect(first.page.nextUri).toEqual(expect.stringMatching(/^foundry:\/\/users\?/));
    world.users[1].name = 'Changed after first page';
    const second = await readUsers(client, first.page.nextUri);
    expect(second.page.records).toEqual([
      { id: id('U', 2), name: 'Other GM', documentType: 'User', active: false, role: 4 },
    ]);
    expect(second.page.nextUri).toBeNull();
    expect(second.page.snapshotId).toBe(first.page.snapshotId);
    for (const { text } of [first, second]) {
      expect(text).not.toContain('PRIVATE_');
      expect(text).not.toContain('password');
      expect(text).not.toContain('authentication');
      expect(text).not.toContain('flags');
      expect(text).not.toContain('futureField');
    }
  });

  it('supports a single online GM without optional user profile fields', async () => {
    const { client, world } = socketClient();
    world.users.splice(1);
    const { page } = await readUsers(client);
    expect(page.records).toEqual([
      { id: id('U', 1), name: 'GM', documentType: 'User', active: true, role: 4 },
    ]);
    expect(page.nextUri).toBeNull();
    expect(page.total).toBe(1);
  });

  it('omits a missing role on a non-caller user without exposing other fields', async () => {
    const { client, world } = socketClient();
    addPrivateFields(world);
    Reflect.deleteProperty(world.users[1], 'role');
    const { text, page } = await readUsers(client);
    expect(page.records[1]).toEqual({
      id: id('U', 2),
      name: 'Other GM',
      documentType: 'User',
      active: false,
    });
    expect(text).not.toContain('PRIVATE_');
  });

  it.each(['_id', 'name'])('fails closed when a user lacks required %s', async (field) => {
    const { client, world } = socketClient();
    Reflect.deleteProperty(world.users[1], field);
    await expect(readUsers(client)).rejects.toThrow();
  });

  it('preserves get_users role and online status without serializing private fields', async () => {
    const { client, world } = socketClient();
    addPrivateFields(world);
    const response = await handleGetUsers({}, client);
    const text = JSON.stringify(response);
    expect(text).toContain('1/2 online');
    expect(text).toContain('**GM** (Game Master) — Online');
    expect(text).toContain('**Other GM** (Game Master) — Offline');
    expect(text).not.toContain('PRIVATE_');
  });
});

describe('REST snapshot pagination', () => {
  it('fetches bounded backend pages and exposes the same immutable client contract', async () => {
    const actors = Array.from({ length: 251 }, (_, index) => ({
      _id: id('A', index),
      name: `Actor ${index}`,
      type: 'npc',
    }));
    get.mockImplementation((_path, options) => {
      const page = options.params.page as number;
      return Promise.resolve({
        data: {
          actors: actors.slice((page - 1) * 100, page * 100),
          total: actors.length,
          snapshotId: 'stable-actors',
          page,
          limit: 100,
        },
      });
    });
    const client = restClient();
    const seen: string[] = [];
    let page = await client.searchActors({ limit: 60 });
    for (;;) {
      seen.push(...page.actors.map((actor) => actor._id));
      if (!page.nextCursor) {
        break;
      }
      page = await client.searchActors({ cursor: page.nextCursor });
    }
    expect(seen).toHaveLength(251);
    expect(new Set(seen).size).toBe(251);
    expect(get).toHaveBeenCalledTimes(8);
    expect(get.mock.calls[0][1].params).not.toHaveProperty('snapshotId');
    expect(
      get.mock.calls.slice(1).every(([, options]) => options.params.snapshotId === 'stable-actors'),
    ).toBe(true);
    expect(get.mock.calls.every(([, options]) => options.params.limit === 100)).toBe(true);
  });

  it.each([
    [
      'ignored paging',
      [{ actors: [{ _id: id('A', 1), name: 'A', type: 'npc' }], total: 2, page: 2, limit: 100 }],
      /ignored requested page/,
    ],
    [
      'duplicate IDs',
      [
        {
          actors: [
            { _id: id('A', 1), name: 'A', type: 'npc' },
            { _id: id('A', 1), name: 'A', type: 'npc' },
          ],
          total: 2,
          page: 1,
          limit: 100,
        },
      ],
      /duplicate/,
    ],
    ['non-progress', [{ actors: [], total: 2, page: 1, limit: 100 }], /made no progress/],
    [
      'inconsistent totals',
      [
        { actors: [{ _id: id('A', 1), name: 'A', type: 'npc' }], total: 2, page: 1, limit: 100 },
        { actors: [{ _id: id('A', 2), name: 'B', type: 'npc' }], total: 3, page: 2, limit: 100 },
      ],
      /inconsistent totals/,
    ],
  ])('rejects REST protocol failure: %s', async (_name, responses, error) => {
    for (const response of responses) {
      get.mockResolvedValueOnce({ data: { snapshotId: 'stable', ...response } });
    }
    await expect(restClient().searchActors({})).rejects.toThrow(error as RegExp);
  });

  for (const collection of ['actors', 'items'] as const) {
    const search = (client: FoundryClient) =>
      collection === 'actors' ? client.searchActors({}) : client.searchItems({});
    const record = (index: number) => ({
      _id: id('A', index),
      name: `Record ${index}`,
      type: 'loot',
    });
    it(`pins the backend snapshot for ${collection}`, async () => {
      get.mockResolvedValueOnce({
        data: {
          [collection]: [record(1)],
          total: 2,
          page: 1,
          limit: 100,
          snapshotId: 'immutable',
        },
      });
      get.mockResolvedValueOnce({
        data: {
          [collection]: [record(2)],
          total: 2,
          page: 2,
          limit: 100,
          snapshotId: 'immutable',
        },
      });
      get.mockResolvedValueOnce({
        data: { [collection]: [record(1)], total: 2, page: 1, limit: 100, snapshotId: 'immutable' },
      });
      const result = await search(restClient());
      expect(result.total).toBe(2);
      expect(get.mock.calls[1][1].params.snapshotId).toBe('immutable');
    });
    for (const surface of ['search', 'resource'] as const) {
      it(`bounds slow ${collection} ${surface} acquisition to the backend lifetime`, async () => {
        const startedAt = Date.now();
        let now = startedAt;
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
        try {
          const client = restClient();
          get.mockImplementation(async (_path, options) => {
            now += 30_000;
            const page = options.params.page;
            return {
              data: {
                [collection]: [record(page)],
                total: 2,
                page,
                limit: 100,
                snapshotId: 'immutable',
              },
            };
          });
          const first = await (surface === 'resource'
            ? client.getCollectionPage(collection, { limit: 1 })
            : collection === 'actors'
              ? client.searchActors({ limit: 1 })
              : client.searchItems({ limit: 1 }));
          expect(first.expiresAt).toBe(new Date(startedAt + 300_000).toISOString());
          expect(get).toHaveBeenCalledTimes(3);
          now = startedAt + 300_000;
          const cursor = requireCursor(first.nextCursor);
          await expect(
            surface === 'resource'
              ? client.getCollectionPage(collection, { cursor })
              : collection === 'actors'
                ? client.searchActors({ cursor })
                : client.searchItems({ cursor }),
          ).rejects.toThrow(/expired/);
          expect(get).toHaveBeenCalledTimes(3);
        } finally {
          clock.mockRestore();
        }
      });
      it(`rejects ${collection} ${surface} snapshots expired during acquisition`, async () => {
        const startedAt = Date.now();
        let now = startedAt;
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
        try {
          const client = restClient();
          get.mockImplementation(async (_path, options) => {
            now += 150_000;
            const page = options.params.page;
            return {
              data: {
                [collection]: [record(page)],
                total: 2,
                page,
                limit: 100,
                snapshotId: 'immutable',
              },
            };
          });
          await expect(
            surface === 'resource'
              ? client.getCollectionPage(collection, { limit: 1 })
              : collection === 'actors'
                ? client.searchActors({ limit: 1 })
                : client.searchItems({ limit: 1 }),
          ).rejects.toThrow(/expired during backend acquisition/);
          expect(get).toHaveBeenCalledTimes(2);
        } finally {
          clock.mockRestore();
        }
      });
      it(`keeps successfully revalidated ${collection} ${surface} pages current`, async () => {
        const data = {
          [collection]: [record(1), record(2), record(3)],
          total: 3,
          page: 1,
          limit: 100,
          snapshotId: 'immutable',
        };
        const client = restClient();
        Reflect.set(client, '_isConnected', true);
        const http = vi.mocked(axios.create).mock.results.at(-1)?.value;
        const observeResponse = vi.mocked(http.interceptors.response.use).mock.calls[0][0];
        get.mockImplementation(async () => observeResponse({ data }));
        const read = (cursor?: string) =>
          surface === 'resource'
            ? client.getCollectionPage(collection, { limit: 1, cursor })
            : collection === 'actors'
              ? client.searchActors({ limit: 1, query: 'Record', cursor })
              : client.searchItems({ limit: 1, query: 'Record', cursor });
        const first = await read();
        const second = await read(requireCursor(first.nextCursor));
        const third = await read(requireCursor(second.nextCursor));
        for (const [index, page] of [first, second, third].entries()) {
          expect(page.readMetadata.freshness).toBe('current');
          expect(page.readMetadata.revision).toBe(index + 2);
          expect(page.snapshotId).toBe(first.snapshotId);
        }
        expect(third.nextCursor).toBeNull();
        expect(get).toHaveBeenCalledTimes(4);
      });
      it(`rechecks ${collection} ${surface} cursors and erases revoked snapshots`, async () => {
        const data = {
          [collection]: [record(1), record(2)],
          total: 2,
          page: 1,
          limit: 100,
          snapshotId: 'immutable',
        };
        get.mockResolvedValue({ data });
        const client = restClient();
        const read = (cursor?: string) =>
          surface === 'resource'
            ? client.getCollectionPage(collection, { limit: 1, cursor })
            : collection === 'actors'
              ? client.searchActors({ limit: 1, query: 'Record', cursor })
              : client.searchItems({ limit: 1, query: 'Record', cursor });
        const first = await read();
        expect(first.nextCursor).toBeTruthy();
        expect(get.mock.calls.at(-1)?.[1].params).toMatchObject({
          page: 1,
          limit: 100,
          snapshotId: 'immutable',
        });
        const cursor = requireCursor(first.nextCursor);
        get.mockRejectedValue(new Error('SNAPSHOT_INVALIDATED: permission changed'));
        await expect(read(cursor)).rejects.toThrow(/SNAPSHOT_INVALIDATED/);
        const calls = get.mock.calls.length;
        await expect(read(cursor)).rejects.toThrow(/no longer available/);
        expect(get.mock.calls.length).toBe(calls);
      });
    }
    it(`requires backend validation even for a single backend page of ${collection}`, async () => {
      get.mockResolvedValue({
        data: { [collection]: [record(1), record(2)], total: 2, page: 1, limit: 100 },
      });
      const client = restClient();
      await expect(
        collection === 'actors'
          ? client.searchActors({ limit: 1 })
          : client.searchItems({ limit: 1 }),
      ).rejects.toThrow(/requires a backend snapshotId for continuation/);
    });
    it(`rejects a changed ${collection} snapshot on revalidation`, async () => {
      const data = {
        [collection]: [record(1), record(2)],
        total: 2,
        page: 1,
        limit: 100,
        snapshotId: 'immutable',
      };
      get.mockResolvedValueOnce({ data });
      get.mockResolvedValueOnce({ data: { ...data, snapshotId: 'replacement' } });
      await expect(search(restClient())).rejects.toThrow(/changed during validation/);
    });
    it(`refuses a multipage ${collection} backend without snapshot support`, async () => {
      get.mockResolvedValueOnce({
        data: {
          [collection]: [record(1)],
          total: 2,
          page: 1,
          limit: 100,
        },
      });
      await expect(search(restClient())).rejects.toThrow(/requires a backend snapshotId/);
      expect(get).toHaveBeenCalledOnce();
    });
    it.each([
      'changed-after-delete-and-append',
      undefined,
    ])(`refuses changed or omitted ${collection} snapshots even when totals and IDs look valid: %s`, async (snapshotId) => {
      get.mockResolvedValueOnce({
        data: {
          [collection]: [record(1)],
          total: 2,
          page: 1,
          limit: 100,
          snapshotId: 'immutable',
        },
      });
      get.mockResolvedValueOnce({
        data: {
          [collection]: [record(3)],
          total: 2,
          page: 2,
          limit: 100,
          snapshotId,
        },
      });
      await expect(search(restClient())).rejects.toThrow(/snapshot changed or was omitted/);
    });
  }

  it('reports unsupported REST collections explicitly', async () => {
    const client = restClient();
    await expect(client.searchJournalsPage({})).rejects.toThrow(/unsupported/);
    await expect(client.searchWorldPage({})).rejects.toThrow(/unsupported/);
    await expect(client.getCollectionPage('scenes', {})).rejects.toThrow(/unsupported/);
  });
});

describe('verified compendium client boundary', () => {
  function capability(
    status: import('../capabilities.js').CapabilityStatus = 'available',
  ): import('../capabilities.js').Capability {
    return {
      feature: 'compendiumSearch',
      status,
      reason: `Verified ${status}`,
      remediation: null,
      verifiedAt: '2026-10-09T00:00:00.000Z',
      transport: 'rest',
    };
  }
  function entries(count = 101) {
    return Array.from({ length: count }, (_, index) => ({
      compendiumId: 'world.test',
      itemId: id('I', index),
      name: `Entry ${String(index).padStart(3, '0')}`,
      type: 'spell',
    })).reverse();
  }
  function compendiumClient() {
    const client = new FoundryClient({
      allowPrivilegedAccount: true,
      baseUrl: 'http://localhost:30000',
      apiKey: 'core-key',
      restUrl: 'https://relay.example.test',
      restApiKey: 'relay-key',
      restClientId: 'client-1',
    });
    const adapter = Reflect.get(
      client,
      'compendiumAdapter',
    ) as import('../rest-compendium.js').CompendiumRestAdapter;
    const probe = vi.spyOn(adapter, 'probe').mockResolvedValue(capability());
    const search = vi
      .spyOn(adapter, 'search')
      .mockResolvedValue({ capability: capability(), entries: entries() });
    return { client, probe, search };
  }
  it('does not mistake a legacy core key for verified relay support', async () => {
    const result = await restClient().searchCompendium({ query: 'x' });
    expect(result).toMatchObject({
      restAvailable: false,
      results: null,
      total: null,
      capability: { status: 'unavailable' },
    });
    expect(get).not.toHaveBeenCalled();
  });
  it('reports socket-only support and unsupported optional features honestly', async () => {
    const { client } = socketClient();
    const report = await client.getCapabilities();
    expect(report.capabilities).toHaveLength(4);
    expect(report.capabilities.every((entry) => entry.status === 'unavailable')).toBe(true);
    expect(report.capabilities[1]).toMatchObject({
      ...RULES_LOOKUP_UNAVAILABLE,
      transport: 'rest',
      verifiedAt: expect.any(String),
    });
    expect(report.capabilities[2]).toMatchObject({
      ...DIAGNOSTICS_UNAVAILABLE,
      transport: 'rest',
      verifiedAt: expect.any(String),
    });
    expect(report.capabilities[3]).toMatchObject({
      ...CONTENT_GENERATION_UNAVAILABLE,
      transport: 'rest',
      verifiedAt: expect.any(String),
    });
    expect(Object.isFrozen(CONTENT_GENERATION_UNAVAILABLE)).toBe(true);
    expect(get).not.toHaveBeenCalled();
  });
  it('does not infer rules, diagnostics, or generation from a working compendium adapter', async () => {
    const { client, probe } = compendiumClient();
    const report = await client.getCapabilities();
    expect(probe).toHaveBeenCalledOnce();
    expect(report.capabilities[0].status).toBe('available');
    expect(report.capabilities[1]).toMatchObject(RULES_LOOKUP_UNAVAILABLE);
    expect(report.capabilities[2]).toMatchObject(DIAGNOSTICS_UNAVAILABLE);
    expect(report.capabilities[3]).toMatchObject(CONTENT_GENERATION_UNAVAILABLE);
    expect(report.capabilities.slice(1).map((entry) => entry.status)).toEqual([
      'unavailable',
      'unavailable',
      'unavailable',
    ]);
  });
  it.each([
    'unavailable',
    'unauthorized',
    'unreachable',
    'incompatible',
  ] as const)('preserves the %s failure instead of fabricating an empty page', async (status) => {
    const { client, search } = compendiumClient();
    search.mockResolvedValue({ capability: capability(status) });
    const result = await client.searchCompendium({ query: 'x', limit: 7 });
    expect(result).toMatchObject({
      schemaVersion: 1,
      restAvailable: false,
      results: null,
      total: null,
      page: null,
      limit: 7,
      nextCursor: null,
      capability: { status },
    });
  });
  it('distinguishes a verified zero match from failure, with a default limit of 20', async () => {
    const { client, search } = compendiumClient();
    search.mockResolvedValue({ capability: capability(), entries: [] });
    expect(await client.searchCompendium({ query: 'none' })).toMatchObject({
      restAvailable: true,
      results: [],
      total: 0,
      limit: 20,
      complete: true,
    });
  });
  it('returns 251 unique immutable entries and verifies capability on every cursor request', async () => {
    const { client, search, probe } = compendiumClient();
    const fixture = entries(251);
    search.mockResolvedValue({ capability: capability(), entries: fixture });
    let page = await client.searchCompendium({ query: 'Entry', limit: 100 });
    if (!page.restAvailable) {
      throw new Error('Expected success');
    }
    expect(page.readMetadata).toMatchObject({ source: 'rest', capturedAt: null, snapshotId: null });
    const observedAt = page.readMetadata.observedAt;
    expect(observedAt).toEqual(expect.any(String));
    fixture[100].name = 'Mutated after snapshot';
    const names: string[] = [];
    const ids: string[] = [];
    for (;;) {
      names.push(...page.results.map((entry) => entry.name));
      ids.push(...page.results.map((entry) => entry.itemId));
      if (!page.nextCursor) {
        break;
      }
      const next = await client.searchCompendium({ query: 'Entry', cursor: page.nextCursor });
      if (!next.restAvailable) {
        throw new Error('Expected success');
      }
      expect(next.readMetadata.observedAt).toBe(observedAt);
      expect(next.readMetadata.capturedAt).toBeNull();
      page = next;
    }
    expect(ids).toHaveLength(251);
    expect(new Set(ids).size).toBe(251);
    expect(names).not.toContain('Mutated after snapshot');
    expect(search).toHaveBeenCalledOnce();
    expect(probe).toHaveBeenCalledTimes(2);
    expect(page.complete).toBe(true);
  });
  it('orders duplicate names by pack and case-sensitive opaque ID', async () => {
    const { client, search } = compendiumClient();
    search.mockResolvedValue({
      capability: capability(),
      entries: [
        { compendiumId: 'world.b', itemId: 'aAAAAAAAAAAAAAAA', name: 'Twin', type: 'spell' },
        { compendiumId: 'world.a', itemId: 'aAAAAAAAAAAAAAAA', name: 'Twin', type: 'spell' },
        { compendiumId: 'world.a', itemId: 'AAAAAAAAAAAAAAAA', name: 'Twin', type: 'spell' },
      ],
    });
    const result = await client.searchCompendium({ query: '' });
    if (!result.restAvailable) {
      throw new Error('Expected success');
    }
    expect(result.results.map((entry) => `${entry.compendiumId}:${entry.itemId}`)).toEqual([
      'world.a:AAAAAAAAAAAAAAAA',
      'world.a:aAAAAAAAAAAAAAAA',
      'world.b:aAAAAAAAAAAAAAAA',
    ]);
  });
  it.each([
    'query',
    'limit',
    'world',
    'relay',
    'relayUrl',
    'relayApiKey',
    'session',
  ] as const)('binds cursors to %s', async (binding) => {
    const { client } = compendiumClient();
    const first = await client.searchCompendium({ query: 'Entry', limit: 1, source: '2014' });
    const cursor = requireCursor(first.nextCursor);
    if (binding === 'world') {
      Reflect.set(client, 'snapshotWorldId', 'other-world');
    }
    if (binding === 'relay') {
      (Reflect.get(client, 'config') as { restClientId: string }).restClientId = 'other-client';
    }
    if (binding === 'relayUrl') {
      (Reflect.get(client, 'config') as { restUrl: string }).restUrl = 'https://other.example.test';
    }
    if (binding === 'relayApiKey') {
      (Reflect.get(client, 'config') as { restApiKey: string }).restApiKey = 'other-key';
    }
    if (binding === 'session') {
      Reflect.set(client, 'paginationSession', 'other-session');
    }
    await expect(
      client.searchCompendium({
        query: binding === 'query' ? 'other' : 'Entry',
        source: '2014',
        ...(binding === 'limit' ? { limit: 2 } : {}),
        cursor,
      }),
    ).rejects.toThrow();
  });
  it('keeps relay cursor context private to each client', async () => {
    const { client: firstClient } = compendiumClient();
    const { client: secondClient } = compendiumClient();
    Reflect.set(secondClient, 'paginationSession', Reflect.get(firstClient, 'paginationSession'));
    const contextHash = async (client: FoundryClient) => {
      const page = await client.searchCompendium({ query: 'Entry', limit: 1 });
      const payload = requireCursor(page.nextCursor).split('.')[0];
      return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).contextHash;
    };
    const firstHash = await contextHash(firstClient);
    expect(await contextHash(firstClient)).toBe(firstHash);
    expect(await contextHash(secondClient)).not.toBe(firstHash);
  });
  it('does not restore old cursors when relay credentials are restored', async () => {
    const { client } = compendiumClient();
    const first = await client.searchCompendium({ query: 'Entry', limit: 1 });
    const cursor = requireCursor(first.nextCursor);
    const config = Reflect.get(client, 'config') as { restApiKey: string };
    const originalKey = config.restApiKey;
    config.restApiKey = 'other-key';
    await client.searchCompendium({ query: 'Entry', limit: 1 });
    config.restApiKey = originalKey;
    await expect(client.searchCompendium({ query: 'Entry', cursor })).rejects.toThrow();
  });
  it.each([
    'unavailable',
    'unauthorized',
  ] as const)('invalidates snapshots after %s and rejects old cursors after recovery', async (status) => {
    const { client, probe } = compendiumClient();
    const first = await client.searchCompendium({ query: 'Entry', limit: 1 });
    const cursor = requireCursor(first.nextCursor);
    probe.mockResolvedValue(capability(status));
    expect(await client.searchCompendium({ query: 'Entry', cursor })).toMatchObject({
      restAvailable: false,
      capability: { status },
    });
    probe.mockResolvedValue(capability());
    await expect(client.searchCompendium({ query: 'Entry', cursor })).rejects.toThrow();
    expect(await client.searchCompendium({ query: 'Entry', limit: 1 })).toMatchObject({
      restAvailable: true,
    });
  });
  it('denies delegated callers before sending compendium HTTP requests', async () => {
    const client = new FoundryClient({
      allowPrivilegedAccount: true,
      baseUrl: 'http://localhost:30000',
      authorizationMode: 'delegated',
      restUrl: 'https://relay.example.test',
      restApiKey: 'key',
      restClientId: 'client',
    });
    await expect(client.searchCompendium({ query: 'x' })).rejects.toThrow();
    await expect(client.getCapabilities()).rejects.toThrow();
    expect(get).not.toHaveBeenCalled();
  });
});
