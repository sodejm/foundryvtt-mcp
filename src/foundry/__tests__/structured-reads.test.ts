import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FoundryClient } from '../client.js';
import type { WorldData } from '../types.js';

vi.mock('axios');
vi.mock('../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const A = 'Actor00000000001';
const B = 'Actor00000000002';
const I = 'Item000000000001';
const J = 'Item000000000002';
const actor = {
  _id: A,
  name: 'Twin',
  type: 'npc',
  level: 0,
  hp: { value: 0, max: 0 },
  ac: { value: 0 },
};
const item = {
  _id: I,
  name: 'Twin',
  type: 'loot',
  description: '',
  rarity: '',
  price: { value: 0, denomination: '' },
  weight: 0,
  quantity: 0,
  equipped: false,
  identified: false,
};
const worldActor = {
  _id: A,
  name: 'Twin',
  type: 'npc',
  img: '',
  system: {
    attributes: { hp: { value: 0, max: 0, temp: 0 }, ac: { value: 0 } },
    details: { level: 0, biography: { value: '' } },
    abilities: { str: { value: 0, mod: 0, save: 0 }, dex: {} },
  },
};
const worldItem = {
  _id: I,
  name: 'Twin',
  type: 'loot',
  img: '',
  system: { ...item, description: { value: '' } },
};
let get: ReturnType<typeof vi.fn>;
function createClient(rest = false) {
  return new FoundryClient({
    baseUrl: 'http://localhost:30000',
    ...(rest ? { apiKey: 'fixture' } : {}),
    retryAttempts: 1,
    retryDelay: 1,
  });
}
function setWorld(client: FoundryClient, overrides: Partial<WorldData> = {}) {
  const world = {
    actors: [worldActor, { ...worldActor, _id: B }],
    items: [worldItem, { ...worldItem, _id: J }],
    ...overrides,
  };
  Reflect.set(client, 'worldData', world);
  return world;
}
beforeEach(() => {
  get = vi.fn();
  vi.mocked(axios.create).mockReturnValue({
    get,
    interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
  } as unknown as ReturnType<typeof axios.create>);
});

for (const surface of [
  {
    name: 'Actor',
    id: A,
    other: B,
    sample: actor,
    collection: 'actors' as const,
    search: (client: FoundryClient) => client.searchActors({ query: 'Twin' }),
    detail: (client: FoundryClient, id: string) => client.getActor(id),
    endpoint: '/api/actors',
  },
  {
    name: 'Item',
    id: I,
    other: J,
    sample: item,
    collection: 'items' as const,
    search: (client: FoundryClient) => client.searchItems({ query: 'Twin' }),
    detail: (client: FoundryClient, id: string) => client.getItem(id),
    endpoint: '/api/items',
  },
]) {
  describe(`${surface.name} client boundary`, () => {
    it('maps REST fields and omits all UUIDs whose source is not verified', async () => {
      const client = createClient(true);
      get.mockResolvedValueOnce({
        data: {
          [surface.collection]: [
            surface.sample,
            { ...surface.sample, _id: surface.other, uuid: `Compendium.pack.${surface.other}` },
          ],
          total: 2,
          page: 1,
          limit: 10,
        },
      });
      const search = await surface.search(client);
      const records =
        surface.collection === 'actors'
          ? 'actors' in search
            ? search.actors
            : []
          : 'items' in search
            ? search.items
            : [];
      expect(records).toHaveLength(2);
      expect(records[0]).toEqual(surface.sample);
      expect(records[1]).not.toHaveProperty('uuid');
      for (const id of [surface.id, surface.other]) {
        get.mockResolvedValueOnce({
          data: { ...surface.sample, _id: id, uuid: `${surface.name}.${id}` },
        });
        const record = await surface.detail(client, id);
        expect(record).toEqual({ ...surface.sample, _id: id });
        expect(get).toHaveBeenLastCalledWith(`${surface.endpoint}/${id}`);
      }
      client.disconnect();
    });
    it('resolves duplicate Socket.IO names to the correct world ID and world UUID', async () => {
      const client = createClient();
      setWorld(client);
      const search = await surface.search(client);
      const records = 'actors' in search ? search.actors : search.items;
      expect(records.map((record) => record._id)).toEqual([surface.id, surface.other]);
      for (const record of records) {
        expect(await surface.detail(client, record._id)).toEqual(record);
        expect(record.uuid).toBe(`${surface.name}.${record._id}`);
      }
      expect(get).not.toHaveBeenCalled();
      client.disconnect();
    });
    it('reports an empty connected world as empty, then a removed record as missing', async () => {
      const client = createClient();
      const world = setWorld(client);
      expect(await surface.detail(client, surface.id)).toMatchObject({ _id: surface.id });
      world[surface.collection] = [];
      await expect(surface.detail(client, surface.id)).rejects.toThrow(`${surface.name} not found`);
      const search = await surface.search(client);
      expect(search).toMatchObject({ [surface.collection]: [], total: 0 });
      client.disconnect();
    });
    it('refuses unavailable cached world instead of fabricating an empty success', async () => {
      const client = createClient();
      await expect(surface.detail(client, surface.id)).rejects.toThrow('Not connected');
      await expect(surface.search(client)).rejects.toThrow('Not connected');
      client.disconnect();
    });
    it.each([
      '',
      '../escape',
      'a/b',
      'short',
      'Actor.123',
      '123456789012345-',
      1234567890123456,
      null,
    ])('rejects invalid ID %s on both transports before HTTP or cache lookup', async (id) => {
      for (const rest of [false, true]) {
        const client = createClient(rest);
        await expect(surface.detail(client, id as string)).rejects.toThrow('Invalid');
        client.disconnect();
      }
      expect(get).not.toHaveBeenCalled();
    });
    it.each([
      null,
      {},
      { name: 'Twin', type: 'npc' },
      { _id: '../bad', name: 'Twin', type: 'npc' },
    ])('rejects malformed REST detail %j', async (data) => {
      const client = createClient(true);
      get.mockResolvedValue({ data });
      await expect(surface.detail(client, surface.id)).rejects.toThrow();
      client.disconnect();
    });
    it('rejects a REST response with the wrong document ID', async () => {
      const client = createClient(true);
      get.mockResolvedValue({ data: { ...surface.sample, _id: surface.other } });
      await expect(surface.detail(client, surface.id)).rejects.toThrow('response ID mismatch');
      client.disconnect();
    });
    it.each([
      null,
      {},
      { [surface.collection]: 'wrong', total: 1, page: 1, limit: 10 },
      { [surface.collection]: [{ ...surface.sample, _id: 'bad' }], total: 1, page: 1, limit: 10 },
    ])('rejects malformed REST search %j', async (data) => {
      const client = createClient(true);
      get.mockResolvedValue({ data });
      await expect(surface.search(client)).rejects.toThrow();
      client.disconnect();
    });
    it.each(['HTTP 404 not found', 'network unavailable'])(
      'propagates REST failure %s',
      async (message) => {
        const client = createClient(true);
        get.mockRejectedValue(new Error(message));
        await expect(surface.detail(client, surface.id)).rejects.toThrow(message);
        await expect(surface.search(client)).rejects.toThrow(message);
        client.disconnect();
      },
    );
  });
}
describe('Socket.IO value fidelity', () => {
  it('preserves zero and empty actor values without inventing missing ability/HP members', async () => {
    const client = createClient();
    setWorld(client);
    expect(await client.getActor(A)).toMatchObject({
      img: '',
      level: 0,
      hp: { value: 0, max: 0, temp: 0 },
      ac: { value: 0 },
      biography: '',
      abilities: { str: { value: 0, mod: 0, save: 0 }, dex: {} },
    });
    setWorld(client, { actors: [{ ...worldActor, system: { attributes: { hp: { value: 0 } } } }] });
    expect(await client.getActor(A)).toMatchObject({ hp: { value: 0 } });
    expect((await client.getActor(A)).hp).not.toHaveProperty('max');
    expect(await client.getActor(A)).not.toHaveProperty('level');
    client.disconnect();
  });
  it('preserves zero, false and empty item values and omits missing optionals', async () => {
    const client = createClient();
    setWorld(client);
    expect(await client.getItem(I)).toMatchObject({ ...item, uuid: `Item.${I}`, img: '' });
    setWorld(client, { items: [{ _id: I, name: '', type: '', system: {} }] });
    expect(await client.getItem(I)).toEqual({ _id: I, uuid: `Item.${I}`, name: '', type: '' });
    client.disconnect();
  });

  it('keeps detail reads scoped to world documents rather than same-ID embedded items', async () => {
    const client = createClient();
    setWorld(client, { actors: [{ ...worldActor, items: [worldItem] }], items: [] });
    await expect(client.getItem(I)).rejects.toThrow('Item not found');
    expect((await client.searchItems({})).items).toEqual([]);
    client.disconnect();
  });
  it('validates only selected cached records after filtering and paging', async () => {
    const client = createClient();
    const invalidActor = { ...worldActor, _id: 'invalid', name: 'Other' };
    const invalidItem = { ...worldItem, _id: 'invalid', name: 'Other' };
    setWorld(client, { actors: [worldActor, invalidActor], items: [worldItem, invalidItem] });
    expect((await client.searchActors({ query: 'Twin' })).actors).toHaveLength(1);
    expect((await client.searchItems({ query: 'Twin' })).items).toHaveLength(1);
    expect((await client.searchActors({ limit: 1 })).actors).toHaveLength(1);
    expect((await client.searchItems({ limit: 1 })).items).toHaveLength(1);
    client.disconnect();
  });
  it('rejects malformed cached document identities and shapes', async () => {
    const client = createClient();
    Reflect.set(client, 'worldData', {
      actors: [{ ...worldActor, name: 42 }],
      items: [{ ...worldItem, system: null }],
    });
    await expect(client.getActor(A)).rejects.toThrow();
    await expect(client.searchActors({})).rejects.toThrow();
    await expect(client.getItem(I)).rejects.toThrow();
    await expect(client.searchItems({})).rejects.toThrow();
    client.disconnect();
  });
});
