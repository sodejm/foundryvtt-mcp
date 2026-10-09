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
  schemaVersion: z.literal(1),
  records: z.array(recordIdentity),
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
  let fault: 'none' | 'unavailable' | 'mismatched-id' | 'malformed-search' = 'none';
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
      const records = [...collection.values()].filter(record =>
        typeof record.name === 'string' && record.name.toLowerCase().includes(query));
      const limit = Number(url.searchParams.get('limit') ?? 10);
      response.end(JSON.stringify({
        [collectionName]: fault === 'malformed-search'
          ? [{ _id: '../bad', name: 'Unusable identity', type: 'weapon' }]
          : records.slice(0, limit),
        total: records.length, page: 1, limit,
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
