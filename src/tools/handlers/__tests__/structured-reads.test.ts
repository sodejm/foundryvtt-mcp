import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import Ajv from 'ajv';
import { describe, expect, it, vi } from 'vitest';
import type { FoundryClient } from '../../../foundry/client.js';
import { getAllTools } from '../../definitions.js';
import { handleGetActorDetails, handleSearchActors } from '../actors.js';
import { handleGetItemDetails, handleSearchItems } from '../items.js';
import { paginationMetadata, readMetadata } from './pagination-fixture.js';

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
function clientStub(data: Record<string, unknown>): FoundryClient {
  return { getReadMetadata: () => readMetadata(), ...data } as unknown as FoundryClient;
}
const surfaces = [
  {
    name: 'actor',
    searchName: 'search_actors',
    detailName: 'get_actor_details',
    documentType: 'Actor',
    sample: actor,
    second: B,
    search: handleSearchActors,
    detail: (id: unknown, client: FoundryClient) =>
      handleGetActorDetails({ actorId: id as string }, client),
    searchMethod: 'searchActors',
    detailMethod: 'getActor',
    collection: 'actors',
  },
  {
    name: 'item',
    searchName: 'search_items',
    detailName: 'get_item_details',
    documentType: 'Item',
    sample: item,
    second: J,
    search: handleSearchItems,
    detail: (id: unknown, client: FoundryClient) =>
      handleGetItemDetails({ itemId: id as string }, client),
    searchMethod: 'searchItems',
    detailMethod: 'getItem',
    collection: 'items',
  },
];
for (const surface of surfaces) {
  describe(`${surface.name} structured read contract`, () => {
    it('distinguishes duplicate names by detail-usable ID and agrees with text and published schemas', async () => {
      const records = [surface.sample, { ...surface.sample, _id: surface.second }];
      const client = clientStub({
        [surface.searchMethod]: vi
          .fn()
          .mockResolvedValue({ [surface.collection]: records, ...paginationMetadata(2) }),
        [surface.detailMethod]: vi.fn((id: string) =>
          Promise.resolve(records.find((r) => r._id === id)),
        ),
      });
      const search = await surface.search({}, client);
      expect(search.structuredContent).toMatchObject({
        schemaVersion: 3,
        documentType: surface.documentType,
        records: [{ id: surface.sample._id }, { id: surface.second }],
      });
      const ajv = new Ajv({ strict: false });
      const schema = getAllTools().find((tool) => tool.name === surface.searchName)?.outputSchema;
      expect(schema).toBeDefined();
      if (!schema) {
        throw new Error('Missing search output schema');
      }
      const validate = ajv.compile(schema);
      expect(validate(search.structuredContent), JSON.stringify(validate.errors)).toBe(true);
      for (const record of search.structuredContent.records) {
        expect(search.content[0]?.text).toContain(record.id);
        const detail = await surface.detail(record.id, client);
        expect(detail.structuredContent.record).toEqual(record);
        expect(detail.content[0]?.text).toContain(record.id);
        const detailSchema = getAllTools().find(
          (tool) => tool.name === surface.detailName,
        )?.outputSchema;
        if (!detailSchema) {
          throw new Error('Missing detail output schema');
        }
        expect(ajv.validate(detailSchema, detail.structuredContent)).toBe(true);
      }
      expect(validate({ ...search.structuredContent, schemaVersion: 1 })).toBe(false);
      expect(validate({ ...search.structuredContent, unexpected: true })).toBe(false);
      expect(
        validate({
          ...search.structuredContent,
          records: [{ name: 'Missing ID', type: 'npc', documentType: surface.documentType }],
        }),
      ).toBe(false);
      expect(
        validate({
          ...search.structuredContent,
          records: [
            {
              ...search.structuredContent.records[0],
              uuid: `Compendium.pack.${surface.sample._id}`,
            },
          ],
        }),
      ).toBe(false);
      expect(validate({ ...search.structuredContent, total: -1 })).toBe(false);
      expect(search.content[0]?.text).toContain(
        surface.name === 'actor' ? 'Level 0 - HP: 0/0' : '(loot) -  - 0 ',
      );

      expect(
        validate({
          ...search.structuredContent,
          records: [{ ...search.structuredContent.records[0], id: '../escape' }],
        }),
      ).toBe(false);
    });
    it('returns a valid empty envelope', async () => {
      const result = await surface.search(
        {},
        clientStub({
          [surface.searchMethod]: vi
            .fn()
            .mockResolvedValue({ [surface.collection]: [], ...paginationMetadata(0) }),
        }),
      );
      expect(result.structuredContent.records).toEqual([]);
      expect(result.content[0]?.text).toContain(`No ${surface.collection} found`);
    });
    it('forwards the complete continuation context and exposes its next cursor in text', async () => {
      const args = {
        query: 'Twin',
        type: 'loot',
        limit: 1,
        cursor: 'previous-cursor',
        ...(surface.name === 'item' && { rarity: 'rare' }),
      };
      const fetch = vi.fn().mockResolvedValue({
        [surface.collection]: [surface.sample],
        ...paginationMetadata(1, 2, 1),
      });
      const result = await surface.search(args, clientStub({ [surface.searchMethod]: fetch }));
      expect(fetch).toHaveBeenCalledExactlyOnceWith(args);
      expect(result.structuredContent).toMatchObject({
        complete: false,
        nextCursor: 'fixture-cursor',
      });
      expect(result.content[0]?.text).toContain('fixture-cursor');
    });
    it.each([
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { limit: '10' },
      { cursor: '' },
      { cursor: 'c'.repeat(1025) },
      { cursor: 1 },
      { query: 'q'.repeat(1025) },
      { query: null },
      { type: 't'.repeat(129) },
      { type: 1 },
      { page: 2 },
      { unknown: true },
      ...(surface.name === 'item'
        ? [{ rarity: 'r'.repeat(129) }, { rarity: false }]
        : [{ rarity: 'rare' }]),
    ])('rejects invalid search input before backend access: %j', async (args) => {
      const fetch = vi.fn();
      await expect(
        surface.search(
          args as Parameters<typeof surface.search>[0],
          clientStub({
            [surface.searchMethod]: fetch,
          }),
        ),
      ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
      expect(fetch).not.toHaveBeenCalled();
    });
    it('rejects an oversized final MCP response instead of truncating it', async () => {
      const fetch = vi.fn().mockResolvedValue({
        [surface.collection]: [{ ...surface.sample, name: 'é'.repeat(70_000) }],
        ...paginationMetadata(1),
      });
      await expect(
        surface.search({}, clientStub({ [surface.searchMethod]: fetch })),
      ).rejects.toMatchObject({
        code: ErrorCode.InternalError,
        message: expect.stringContaining('request a smaller limit'),
      });
    });
    it('omits missing optional values rather than inventing them', async () => {
      const result = await surface.detail(
        surface.sample._id,
        clientStub({
          [surface.detailMethod]: vi
            .fn()
            .mockResolvedValue({ _id: surface.sample._id, name: '', type: '' }),
        }),
      );
      expect(result.structuredContent.record).toEqual({
        id: surface.sample._id,
        documentType: surface.documentType,
        name: '',
        type: '',
      });
    });
    it.each([
      '',
      '../escape',
      'a/b',
      'Actor.123',
      'short',
      'Actor0000000000-',
      42,
      null,
      undefined,
    ])('rejects invalid ID %s before client access', async (id) => {
      const fetch = vi.fn();
      await expect(
        surface.detail(id, clientStub({ [surface.detailMethod]: fetch })),
      ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
      expect(fetch).not.toHaveBeenCalled();
    });
    it.each([
      null,
      {},
      { ...surface.sample, _id: surface.second },
      { ...surface.sample, _id: '../escape' },
      { ...surface.sample, name: 3 },
    ])('rejects malformed or mismatched detail %j', async (response) => {
      await expect(
        surface.detail(
          surface.sample._id,
          clientStub({ [surface.detailMethod]: vi.fn().mockResolvedValue(response) }),
        ),
      ).rejects.toThrow(McpError);
    });
    it.each([
      'not found',
      'removed',
      'Not connected — no world data available',
      'network unavailable',
    ])('reports backend failure %s', async (message) => {
      await expect(
        surface.detail(
          surface.sample._id,
          clientStub({ [surface.detailMethod]: vi.fn().mockRejectedValue(new Error(message)) }),
        ),
      ).rejects.toMatchObject({
        code: ErrorCode.InternalError,
        message: expect.stringContaining(message),
      });
    });
    it.each([
      {},
      { total: 1, page: 1, limit: 10 },
      { total: 1, page: 1, limit: 10, badRecords: true },
    ])('rejects malformed search response %j', async (response) => {
      await expect(
        surface.search(
          {},
          clientStub({ [surface.searchMethod]: vi.fn().mockResolvedValue(response) }),
        ),
      ).rejects.toThrow(McpError);
    });

    it('rejects invalid types in optional display values without coercion', async () => {
      const invalid =
        surface.name === 'actor'
          ? { ...surface.sample, hp: { value: '0', max: 0 } }
          : { ...surface.sample, price: { value: '0', denomination: '' } };
      await expect(
        surface.detail(
          surface.sample._id,
          clientStub({ [surface.detailMethod]: vi.fn().mockResolvedValue(invalid) }),
        ),
      ).rejects.toThrow(McpError);
      await expect(
        surface.search(
          {},
          clientStub({
            [surface.searchMethod]: vi
              .fn()
              .mockResolvedValue({ [surface.collection]: [invalid], total: 1, page: 1, limit: 10 }),
          }),
        ),
      ).rejects.toThrow(McpError);
    });
    it('rejects cross-scope or mismatched UUIDs', async () => {
      for (const uuid of [
        `Compendium.pack.${surface.sample._id}`,
        `${surface.documentType}.${surface.second}`,
      ]) {
        await expect(
          surface.detail(
            surface.sample._id,
            clientStub({
              [surface.detailMethod]: vi.fn().mockResolvedValue({ ...surface.sample, uuid }),
            }),
          ),
        ).rejects.toThrow(McpError);
      }
    });
    it('retains a verified UUID and drops unsupported payload fields', async () => {
      const uuid = `${surface.documentType}.${surface.sample._id}`;
      const result = await surface.detail(
        surface.sample._id,
        clientStub({
          [surface.detailMethod]: vi.fn().mockResolvedValue({
            ...surface.sample,
            uuid,
            system: { secret: 'private' },
            unknown: 'ignored',
          }),
        }),
      );
      expect(result.structuredContent.record.uuid).toBe(uuid);
      expect(result.structuredContent.record).not.toHaveProperty('system');
      expect(result.structuredContent.record).not.toHaveProperty('unknown');
    });
  });
}

describe('zero, false and empty display values', () => {
  it('preserves absent ability modifiers and displays negative modifiers accurately', async () => {
    const result = await handleGetActorDetails(
      { actorId: A },
      clientStub({
        getActor: vi.fn().mockResolvedValue({
          ...actor,
          abilities: { str: { value: 0 }, dex: { value: 8, mod: -1 }, con: { mod: 0 } },
        }),
      }),
    );
    expect(result.structuredContent.record.abilities).toEqual({
      str: { value: 0 },
      dex: { value: 8, mod: -1 },
      con: { mod: 0 },
    });
    expect(result.content[0]?.text).toContain('**STR:** 0 (Unknown)');
    expect(result.content[0]?.text).toContain('**DEX:** 8 (-1)');
    expect(result.content[0]?.text).toContain('**CON:** Unknown (+0)');
  });

  it('shows zero actor HP, AC, level and ability scores without Unknown', async () => {
    const result = await handleGetActorDetails(
      { actorId: A },
      clientStub({
        getActor: vi
          .fn()
          .mockResolvedValue({ ...actor, abilities: { str: { value: 0, mod: 0 } }, biography: '' }),
      }),
    );
    expect(result.structuredContent.record).toMatchObject({
      level: 0,
      hp: { value: 0, max: 0 },
      ac: { value: 0 },
      biography: '',
    });
    expect(result.content[0]?.text).toContain('**Level:** 0');
    expect(result.content[0]?.text).toContain('**Hit Points:** 0/0');
    expect(result.content[0]?.text).toContain('**Armor Class:** 0');
    expect(result.content[0]?.text).toContain('**STR:** 0 (+0)');
  });
  it('shows zero item price/weight/quantity and false flags, preserves empty strings', async () => {
    const result = await handleGetItemDetails(
      { itemId: I },
      clientStub({ getItem: vi.fn().mockResolvedValue(item) }),
    );
    expect(result.structuredContent.record).toMatchObject({
      description: '',
      rarity: '',
      price: { value: 0, denomination: '' },
      weight: 0,
      quantity: 0,
      equipped: false,
      identified: false,
    });
    expect(result.content[0]?.text).toContain('**Price:** 0 ');
    expect(result.content[0]?.text).toContain('**Weight:** 0');
    expect(result.content[0]?.text).toContain('**Quantity:** 0');
    expect(result.content[0]?.text).toContain('**Equipped:** false');
    expect(result.content[0]?.text).toContain('**Identified:** false');
  });
});
