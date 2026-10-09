import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import Ajv from 'ajv';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

const actorIds = ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', 'eeeeeeeeeeeeeeee'];
const itemIds = ['cccccccccccccccc', 'dddddddddddddddd', 'ffffffffffffffff'];
const recordIdentity = z.object({
  id: z.string(),
  documentType: z.enum(['Actor', 'Item']),
  name: z.string(),
  type: z.string(),
}).passthrough();
const searchEnvelope = z.object({
  schemaVersion: z.literal(2),
  records: z.array(recordIdentity),
  total: z.number(), page: z.number(), limit: z.number(), returnedCount: z.number(),
  nextCursor: z.string().nullable(), complete: z.boolean(),
  snapshotId: z.string(), expiresAt: z.string(), consistency: z.literal('snapshot'),
}).passthrough();
const detailEnvelope = z.object({
  schemaVersion: z.literal(1),
  record: recordIdentity,
}).passthrough();

// Test-only REST data, never real credentials or a claim of Foundry compatibility.
const actorFixtures = actorIds.map((_id, index) => ({
  _id,
  name: index === 2 ? 'Optional fields absent' : 'Same actor name',
  type: 'character',
  ...(index === 0 ? { level: 0, hp: { value: 0, max: 0 }, ac: { value: 0 } } : {}),
  ...(index === 1 ? { level: 7, hp: { value: 21, max: 30 } } : {}),
}));
const itemFixtures = itemIds.map((_id, index) => ({
  _id,
  name: index === 2 ? 'Optional fields absent' : 'Same item name',
  type: 'weapon',
  ...(index === 0 ? {
    price: { value: 0, denomination: '' }, rarity: '', description: '',
    weight: 0, quantity: 0, equipped: false, identified: false,
  } : {}),
  ...(index === 1 ? { price: { value: 5, denomination: 'gp' }, rarity: 'rare' } : {}),
}));

describe('built MCP CLI structured read workflow', () => {
  let fixtureServer: Server;
  let client: Client;
  let transport: StdioClientTransport;
  let temporaryCwd: string;
  let actors = new Map<string, Record<string, unknown>>();
  let items = new Map<string, Record<string, unknown>>();
  let fault: 'none' | 'unavailable' | 'mismatched-id' | 'malformed-search'
    | 'ignored-page' | 'duplicate-page' | 'nonprogress' | 'inconsistent-total' = 'none';
  let requests: string[] = [];
  const schemas = new Map<string, object>();
  const ajv = new Ajv({ allErrors: true, strict: false });

  beforeEach(() => {
    actors = new Map(actorFixtures.map(record => [record._id, structuredClone(record)]));
    items = new Map(itemFixtures.map(record => [record._id, structuredClone(record)]));
    fault = 'none';
    requests = [];
  });

  beforeAll(async () => {
    fixtureServer = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      requests.push(url.pathname);
      response.setHeader('Content-Type', 'application/json');
      if (url.pathname === '/api/status') {
        response.end(JSON.stringify({ connected: true }));
        return;
      }
      if (fault === 'unavailable') {
        response.statusCode = 503;
        response.end(JSON.stringify({ error: 'Fixture unavailable' }));
        return;
      }
      const match = /^\/api\/(actors|items)(?:\/([^/]+))?$/.exec(url.pathname);
      if (!match) {
        response.statusCode = 404;
        response.end('{}');
        return;
      }
      const collectionName = match[1] === 'actors' ? 'actors' : 'items';
      const collection = collectionName === 'actors' ? actors : items;
      const id = match[2];
      if (id) {
        const record = collection.get(id);
        if (!record) {
          response.statusCode = 404;
          response.end(JSON.stringify({ error: 'Document removed or missing' }));
          return;
        }
        response.end(JSON.stringify(fault === 'mismatched-id'
          ? { ...record, _id: 'zzzzzzzzzzzzzzzz' } : record));
        return;
      }
      const query = (url.searchParams.get('query') ?? '').toLowerCase();
      const type = url.searchParams.get('type');
      const rarity = url.searchParams.get('rarity');
      const records = [...collection.values()].filter(record =>
        typeof record.name === 'string' && record.name.toLowerCase().includes(query)
        && (!type || record.type === type) && (!rarity || record.rarity === rarity));
      const limit = Number(url.searchParams.get('limit') ?? 10);
      const page = Number(url.searchParams.get('page') ?? 1);
      const offset = fault === 'duplicate-page' ? 0 : (page - 1) * limit;
      response.end(JSON.stringify({
        [collectionName]: fault === 'malformed-search'
          ? [{ _id: '../bad', name: 'Unusable identity', type: 'weapon' }]
          : fault === 'nonprogress' && page > 1 ? [] : records.slice(offset, offset + limit),
        total: records.length + (fault === 'inconsistent-total' && page > 1 ? 1 : 0),
        page: fault === 'ignored-page' ? 1 : page, limit,
      }));
    });
    await new Promise<void>((resolve, reject) => {
      fixtureServer.once('error', reject);
      fixtureServer.listen(0, '127.0.0.1', resolve);
    });
    const address = fixtureServer.address();
    if (!address || typeof address === 'string') throw new Error('No fixture port allocated');
    temporaryCwd = await mkdtemp(join(tmpdir(), 'foundry-mcp-workflow-'));
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('../../dist/index.js', import.meta.url))],
      cwd: temporaryCwd,
      stderr: 'pipe',
      env: {
        NODE_ENV: 'test', LOG_LEVEL: 'error',
        FOUNDRY_URL: `http://127.0.0.1:${address.port}`,
        FOUNDRY_API_KEY: 'workflow-fixture-key',
        FOUNDRY_TIMEOUT: '500', FOUNDRY_RETRY_ATTEMPTS: '0', FOUNDRY_RETRY_DELAY: '1',
      },
    });
    // Drain errors from expected negative tests without retaining sensitive logs.
    transport.stderr?.on('data', () => {});
    client = new Client({ name: 'structured-read-workflow', version: '1.0.0' });
    await client.connect(transport);
    const listed = await client.listTools();
    for (const tool of listed.tools) {
      if (tool.outputSchema) schemas.set(tool.name, tool.outputSchema);
    }
  });

  afterAll(async () => {
    await client?.close();
    await transport?.close();
    if (fixtureServer) {
      fixtureServer.closeAllConnections();
      await new Promise<void>(resolve => fixtureServer.close(() => resolve()));
    }
    if (temporaryCwd) await rm(temporaryCwd, { recursive: true, force: true });
  });

  async function call(name: string, args: Record<string, unknown>) {
    const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
    const schema = schemas.get(name);
    expect(schema, `${name} advertises its output schema`).toBeDefined();
    expect(ajv.validate(schema!, result.structuredContent), JSON.stringify(ajv.errors)).toBe(true);
    const text = result.content.flatMap(block =>
      block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n');
    return { structured: result.structuredContent, text };
  }

  function seed(collection: Map<string, Record<string, unknown>>, count: number) {
    collection.clear();
    for (let index = count - 1; index >= 0; index -= 1) {
      const id = String(index).padStart(16, '0');
      collection.set(id, { _id: id, name: 'Paging duplicate',
        type: index % 2 ? 'npc' : 'character', rarity: index % 3 ? 'common' : 'rare' });
    }
    return [...collection.keys()].sort();
  }

  async function readPage(uri: string) {
    const result = await client.readResource({ uri });
    const content = result.contents[0];
    if (!content || !('text' in content)) throw new Error('Missing resource text');
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(128 * 1024);
    return { ...searchEnvelope.parse(JSON.parse(content.text)),
      nextUri: z.string().nullable().parse(JSON.parse(content.text).nextUri) };
  }

  it.each(['search_actors', 'search_items'])(
    '%s traverses 0, 1, 100, 101 and 251 records without duplicate or missing IDs', async name => {
      for (const count of [0, 1, 100, 101, 251]) {
        const expected = seed(name === 'search_actors' ? actors : items, count);
        const ids: string[] = [];
        let cursor: string | null = null;
        let snapshotId: string | undefined;
        let page = 0;
        do {
          const response = await call(name, { limit: 100, ...(cursor && { cursor }) });
          const result = searchEnvelope.parse(response.structured);
          snapshotId ??= result.snapshotId;
          expect(result).toMatchObject({ total: count, page: ++page, limit: 100, snapshotId,
            returnedCount: result.records.length, complete: result.nextCursor === null });
          expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(128 * 1024);
          for (const record of result.records) expect(response.text).toContain(record.id);
          ids.push(...result.records.map(record => record.id));
          cursor = result.nextCursor;
        } while (cursor);
        expect(ids).toEqual(expected);
      }
    },
  );

  it.each(['search_actors', 'search_items'])(
    '%s preserves a snapshot across create, update and delete and permits deterministic replay', async name => {
      const collection = name === 'search_actors' ? actors : items;
      const expected = seed(collection, 251);
      const first = searchEnvelope.parse((await call(name, { limit: 100 })).structured);
      const deletedId = expected[150]!;
      collection.delete(deletedId);
      collection.set('zzzzzzzzzzzzzzzz', { _id: 'zzzzzzzzzzzzzzzz', name: 'A new record', type: 'npc' });
      collection.get(expected[151]!)!.name = 'A renamed record';
      const args = { limit: 100, cursor: first.nextCursor! };
      const second = searchEnvelope.parse((await call(name, args)).structured);
      expect(searchEnvelope.parse((await call(name, args)).structured)).toEqual(second);
      const third = searchEnvelope.parse((await call(name, { limit: 100, cursor: second.nextCursor! })).structured);
      expect([...first.records, ...second.records, ...third.records].map(record => record.id)).toEqual(expected);
      expect(second.records.find(record => record.id === deletedId)).toBeDefined();
      expect(second.records.find(record => record.id === expected[151])?.name).toBe('Paging duplicate');
      const fresh = searchEnvelope.parse((await call(name, { limit: 100 })).structured);
      expect(fresh.snapshotId).not.toBe(first.snapshotId);
      expect(fresh.records[0]?.id).toBe('zzzzzzzzzzzzzzzz');
    },
  );

  it('applies restrictive filters before counts and pagination', async () => {
    seed(items, 251);
    const response = await call('search_items', { query: 'duplicate', type: 'npc', rarity: 'rare', limit: 100 });
    const result = searchEnvelope.parse(response.structured);
    expect(result).toMatchObject({ total: 42, returnedCount: 42, complete: true });
    expect(result.records.every(record => record.type === 'npc' && record.rarity === 'rare')).toBe(true);
  });

  it.each(['actors', 'items'])(
    'follows nextUri through all 251 foundry://%s records', async collectionName => {
      const expected = seed(collectionName === 'actors' ? actors : items, 251);
      const ids: string[] = [];
      let uri: string | null = `foundry://${collectionName}`;
      while (uri) {
        const page = await readPage(uri);
        expect(page.limit).toBe(100);
        ids.push(...page.records.map(record => record.id));
        if (page.nextUri) expect(new URL(page.nextUri).searchParams.get('cursor')).toBe(page.nextCursor);
        uri = page.nextUri;
      }
      expect(ids).toEqual(expected);
    },
  );

  it('advertises templates for all five collection resources', async () => {
    const listed = await client.listResourceTemplates();
    expect(listed.resourceTemplates.map(template => template.uriTemplate).sort()).toEqual(
      ['actors', 'items', 'scenes', 'journals', 'users'].map(name => `foundry://${name}{?limit,cursor}`).sort(),
    );
  });

  it.each(['ignored-page', 'duplicate-page', 'nonprogress', 'inconsistent-total'] as const)(
    'fails explicitly when the REST backend returns %s', async nextFault => {
      for (const name of ['search_actors', 'search_items']) {
        seed(name === 'search_actors' ? actors : items, 251);
        fault = nextFault;
        await expect(client.callTool({ name, arguments: { limit: 100 } })).rejects.toThrow();
      }
    },
  );

  it('rejects corrupted, cross-tool, query, filter and limit mismatched cursors', async () => {
    seed(actors, 251);
    const first = searchEnvelope.parse((await call('search_actors', { limit: 100 })).structured);
    for (const [name, args] of [
      ['search_actors', { limit: 100, cursor: 'corrupt' }],
      ['search_items', { limit: 100, cursor: first.nextCursor }],
      ['search_actors', { limit: 100, query: 'changed', cursor: first.nextCursor }],
      ['search_actors', { limit: 100, type: 'npc', cursor: first.nextCursor }],
      ['search_actors', { limit: 99, cursor: first.nextCursor }],
    ] as const) {
      await expect(client.callTool({ name, arguments: args })).rejects.toThrow();
    }
  });

  it.each(['search_actors', 'search_items', 'search_journals', 'search_world'])(
    '%s rejects bounded input violations before backend access', async name => {
      for (const args of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: '10' },
        { cursor: '' }, { cursor: 'x'.repeat(1025) }, { query: 'x'.repeat(1025) }]) {
        const before = requests.length;
        await expect(client.callTool({ name, arguments: args })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
        expect(requests).toHaveLength(before);
      }
    },
  );

  it.each(['scenes', 'journals', 'users'])(
    'reports unsupported REST collection %s instead of partial data', async name => {
      await expect(client.readResource({ uri: `foundry://${name}` })).rejects.toThrow(/unsupported/i);
    },
  );

  it.each(['search_journals', 'search_world'])('%s reports unsupported REST search', async name => {
    await expect(client.callTool({ name, arguments: {} })).rejects.toThrow(/unsupported/i);
  });

  it('rejects an oversized record rather than claiming a complete empty page', async () => {
    actors.clear();
    actors.set(actorIds[0]!, { _id: actorIds[0], name: 'x'.repeat(200_000), type: 'npc' });
    await expect(client.callTool({ name: 'search_actors', arguments: { limit: 1 } })).rejects.toThrow();
  });

  it('advertises all four result schemas and rejects an invalid result against each', () => {
    for (const name of ['search_actors', 'get_actor_details', 'search_items', 'get_item_details']) {
      const schema = schemas.get(name);
      expect(schema).toBeDefined();
      expect(ajv.validate(schema!, { schemaVersion: 999 })).toBe(false);
    }
  });

  it.each([
    ['Actor', 'search_actors', 'get_actor_details', 'actorId', 'Same actor name', actorIds],
    ['Item', 'search_items', 'get_item_details', 'itemId', 'Same item name', itemIds],
  ] as const)('selects both duplicate-name %s documents through search and detail', async (
    documentType, searchTool, detailTool, idArgument, query, ids,
  ) => {
    const search = await call(searchTool, { query });
    const envelope = searchEnvelope.parse(search.structured);
    expect(envelope.records.map(record => record.id)).toEqual(ids.slice(0, 2));
    for (const record of envelope.records) {
      expect(record.documentType).toBe(documentType);
      expect(record.name).toBe(query);
      expect(record).not.toHaveProperty('uuid'); // REST source has no proven scope.
      expect(search.text).toContain(record.id);
      const detail = await call(detailTool, { [idArgument]: record.id });
      const resolved = detailEnvelope.parse(detail.structured).record;
      expect(resolved).toEqual(record);
      expect(detail.text).toContain(record.id);
    }
  });

  it('preserves zero actor values and zero/false/empty item values', async () => {
    const actor = await call('get_actor_details', { actorId: actorIds[0] });
    expect(detailEnvelope.parse(actor.structured).record).toMatchObject({
      level: 0, hp: { value: 0, max: 0 }, ac: { value: 0 },
    });
    expect(actor.text).toContain('0/0');
    const item = await call('get_item_details', { itemId: itemIds[0] });
    expect(detailEnvelope.parse(item.structured).record).toMatchObject({
      price: { value: 0, denomination: '' }, rarity: '', description: '',
      quantity: 0, weight: 0, identified: false, equipped: false,
    });
    expect(item.text).toContain('false');
    expect(item.text).not.toContain('Unknown price');
  });

  it.each([
    ['search_actors', 'get_actor_details', 'actorId', actorIds[2], 'hp'],
    ['search_items', 'get_item_details', 'itemId', itemIds[2], 'price'],
  ] as const)('%s handles empty matches and absent optional values', async (
    searchTool, detailTool, idArgument, id, absentField,
  ) => {
    const empty = await call(searchTool, { query: 'no fixture has this name' });
    expect(searchEnvelope.parse(empty.structured).records).toEqual([]);
    const detail = await call(detailTool, { [idArgument]: id });
    expect(detailEnvelope.parse(detail.structured).record).not.toHaveProperty(absentField);
  });

  it.each(['', '../escape', 'Actor.aaaaaaaaaaaaaaaa', 'short', 42, null])(
    'rejects invalid detail ID %j before backend lookup', async id => {
      for (const [name, key] of [['get_actor_details', 'actorId'], ['get_item_details', 'itemId']]) {
        const previousRequests = requests.length;
        await expect(client.callTool({ name: name!, arguments: { [key!]: id } }))
          .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
        expect(requests).toHaveLength(previousRequests);
      }
    },
  );

  it.each([
    ['search_actors', 'get_actor_details', 'actorId', actorIds[0], 'actors'],
    ['search_items', 'get_item_details', 'itemId', itemIds[0], 'items'],
  ] as const)('%s never resolves a removed document to another same-name record', async (
    searchTool, detailTool, idArgument, id, collectionName,
  ) => {
    await call(searchTool, { query: 'Same' });
    (collectionName === 'actors' ? actors : items).delete(id);
    await expect(client.callTool({ name: detailTool, arguments: { [idArgument]: id } }))
      .rejects.toThrow();
  });

  it.each(['get_actor_details', 'get_item_details'])('%s rejects a mismatched REST identity', async name => {
    fault = 'mismatched-id';
    const args = name === 'get_actor_details' ? { actorId: actorIds[0] } : { itemId: itemIds[0] };
    await expect(client.callTool({ name, arguments: args })).rejects.toThrow();
  });

  it.each(['search_actors', 'search_items'])('%s rejects malformed record identity', async name => {
    fault = 'malformed-search';
    await expect(client.callTool({ name, arguments: {} })).rejects.toThrow();
  });

  it.each(['search_actors', 'search_items', 'get_actor_details', 'get_item_details'])(
    '%s reports backend failure instead of empty/successful data', async name => {
      fault = 'unavailable';
      const args = name === 'get_actor_details' ? { actorId: actorIds[0] }
        : name === 'get_item_details' ? { itemId: itemIds[0] } : {};
      await expect(client.callTool({ name, arguments: args })).rejects.toThrow();
    },
  );
});
