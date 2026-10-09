import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  const client = new FoundryClient({ baseUrl: 'http://localhost:30000' });
  const actors = Array.from({ length: 101 }, (_, index) => ({
    _id: id('A', index),
    name: `Actor ${String(index).padStart(3, '0')}`,
    type: index % 2 ? 'npc' : 'character',
    system: {},
  }));
  const items = [
    { _id: id('I', 1), name: 'Twin', type: 'weapon', system: { rarity: 'rare' } },
    { _id: id('I', 2), name: 'Twin', type: 'loot', system: { rarity: 'common' } },
  ];
  const world: WorldData = {
    userId: id('U', 1),
    release: {},
    world: { id: 'world-1', title: 'World' },
    system: {},
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
  return { client, world };
}

function restClient() {
  return new FoundryClient({ baseUrl: 'http://localhost:30000', apiKey: 'key' });
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

  it('rejects non-GM cached-world reads', async () => {
    const { client } = socketClient(3);
    await expect(client.searchActors({})).rejects.toThrow(/authenticated GM/);
    await expect(client.searchWorldPage({})).rejects.toThrow(/authenticated GM/);
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
    expect(get).toHaveBeenCalledTimes(3);
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
      get.mockResolvedValueOnce({ data: response });
    }
    await expect(restClient().searchActors({})).rejects.toThrow(error as RegExp);
  });

  it('reports unsupported REST collections explicitly', async () => {
    const client = restClient();
    await expect(client.searchJournalsPage({})).rejects.toThrow(/unsupported/);
    await expect(client.searchWorldPage({})).rejects.toThrow(/unsupported/);
    await expect(client.getCollectionPage('scenes', {})).rejects.toThrow(/unsupported/);
  });
});
