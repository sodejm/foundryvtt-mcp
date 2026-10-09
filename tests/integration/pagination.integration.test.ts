/** Live pagination through the built MCP process and a disposable Socket.IO world. */
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import Ajv from 'ajv';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FoundryClient } from '../../src/foundry/client.js';
import { worldReadMetadataSchema } from '../../src/foundry/freshness.js';
import { createConnectedClient } from './setup.js';

const recordSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9]{16}$/),
  documentType: z.enum(['Actor', 'Item', 'Scene', 'JournalEntry', 'User']),
  name: z.string(),
}).passthrough();
const pageSchema = z.object({
  schemaVersion: z.union([z.literal(3), z.literal(4)]),
  records: z.array(recordSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().min(1).max(100),
  returnedCount: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
  complete: z.boolean(),
  snapshotId: z.string(),
  expiresAt: z.iso.datetime(),
  consistency: z.literal('snapshot'),
  readMetadata: worldReadMetadataSchema,
}).passthrough();
type Page = z.infer<typeof pageSchema>;
type DocumentType = 'Actor' | 'Item' | 'JournalEntry' | 'Scene';
type Writer = {
  modifyDocument(type: DocumentType, action: 'create' | 'update' | 'delete', operation: Record<string, unknown>): Promise<Array<{ _id: string }>>;
};

describe('live bounded pagination through MCP stdio', () => {
  let foundry: FoundryClient | undefined;
  let mcp: Client | undefined;
  let transport: StdioClientTransport | undefined;
  const prefix = `MCP Pagination ${process.pid} ${Date.now()}`;
  const owned = new Map<DocumentType, Set<string>>();
  const initial = new Map<DocumentType, string[]>();
  const schemas = new Map<string, object>();
  const ajv = new Ajv({ allErrors: true, strict: false });

  function writer(): Writer {
    if (!foundry) throw new Error('Live fixture connection is required');
    return foundry as unknown as Writer;
  }

  async function create(type: DocumentType, data: Record<string, unknown>[]) {
    const created = await writer().modifyDocument(type, 'create', { data });
    const ids = owned.get(type) ?? new Set<string>();
    for (const document of created) ids.add(document._id);
    owned.set(type, ids);
    expect(created).toHaveLength(data.length);
    return created.map(document => document._id);
  }

  beforeAll(async () => {
    foundry = await createConnectedClient({ writeEnabled: true });
    if (foundry.getWorldData()?.world.id !== 'test1world') {
      throw new Error('Pagination fixture writes require the disposable test1world');
    }
    for (const type of ['Actor', 'Item', 'JournalEntry', 'Scene'] as const) {
      const count = type === 'Actor' || type === 'Item' ? 251 : 3;
      const ids: string[] = [];
      for (let offset = 0; offset < count; offset += 50) {
        ids.push(...await create(type, Array.from({ length: Math.min(50, count - offset) }, () => ({
          name: `${prefix} Duplicate ${type}`,
          ...(type === 'Actor' && { type: 'npc' }),
          ...(type === 'Item' && { type: 'loot' }),
          ...(type === 'JournalEntry' && { pages: [] }),
          ...(type === 'Scene' && { active: false, width: 1000, height: 1000 }),
        }))));
      }
      initial.set(type, ids.sort());
    }
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('../../dist/index.js', import.meta.url))],
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      stderr: 'pipe',
      env: Object.fromEntries(Object.entries({
        ...process.env,
        NODE_ENV: 'test', LOG_LEVEL: 'error',
        FOUNDRY_URL: process.env.FOUNDRY_URL ?? 'http://127.0.0.1:30001',
        FOUNDRY_USERNAME: process.env.FOUNDRY_USERNAME ?? 'Gamemaster',
        FOUNDRY_PASSWORD: process.env.FOUNDRY_PASSWORD ?? '',
      }).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    });
    transport.stderr?.on('data', () => {});
    mcp = new Client({ name: 'live-pagination-integration', version: '1.0.0' });
    await mcp.connect(transport);
    for (const tool of (await mcp.listTools()).tools) {
      if (tool.outputSchema) schemas.set(tool.name, tool.outputSchema);
    }
  });

  afterAll(async () => {
    await Promise.allSettled([mcp?.close(), transport?.close()]);
    try {
      for (const [type, ids] of owned) {
        if (ids.size > 0) await writer().modifyDocument(type, 'delete', { ids: [...ids] });
      }
    } finally {
      await foundry?.disconnect();
    }
  });

  function client() {
    if (!mcp) throw new Error('MCP client is required');
    return mcp;
  }

  async function search(name: string, args: Record<string, unknown>): Promise<Page> {
    const response = await client().callTool({ name, arguments: args });
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(128 * 1024);
    const schema = schemas.get(name);
    expect(schema, `${name} output schema`).toBeDefined();
    expect(ajv.validate(schema!, response.structuredContent), JSON.stringify(ajv.errors)).toBe(true);
    const page = pageSchema.parse(response.structuredContent);
    expect(page.schemaVersion).toBe(name === 'search_items' ? 4 : 3);
    const text = response.content as Array<{ type: string; text?: string }>;
    const rendered = text.map(block => block.text ?? '').join('\n');
    for (const record of page.records) expect(rendered).toContain(record.id);
    expect(page.returnedCount).toBe(page.records.length);
    return page;
  }

  async function traverse(name: string, args: Record<string, unknown>, first?: Page) {
    let page = first ?? await search(name, args);
    const snapshot = page.snapshotId;
    const { freshness: _freshness, respondedAt: _respondedAt, ...provenance } = page.readMetadata;
    const pages: Page[] = [];
    do {
      pages.push(page);
      expect(page.snapshotId).toBe(snapshot);
      const { freshness, respondedAt, ...source } = page.readMetadata;
      expect(source).toEqual(provenance);
      expect(['current', 'stale']).toContain(freshness);
      expect(Date.parse(respondedAt)).toBeGreaterThanOrEqual(Date.parse(provenance.observedAt!));
      expect(page.page).toBe(pages.length);
      expect(page.complete).toBe(page.nextCursor === null);
      if (page.nextCursor === null) break;
      page = await search(name, { ...args, cursor: page.nextCursor });
    } while (pages.length < 100);
    const records = pages.flatMap(result => result.records);
    expect(records).toHaveLength(page.total);
    expect(new Set(records.map(record => `${record.documentType}.${record.id}`)).size).toBe(page.total);
    return { pages, records };
  }

  it.each([
    ['Actor', 'search_actors'], ['Item', 'search_items'],
  ] as const)('traverses 251 duplicate-name %s records with exact stable IDs', async (type, tool) => {
    const { pages, records } = await traverse(tool, { query: `${prefix} Duplicate ${type}`, limit: 100 });
    expect(pages.map(page => page.returnedCount)).toEqual([100, 100, 51]);
    expect(records.map(record => record.id)).toEqual(initial.get(type));
  });

  it('returns a complete empty snapshot for a restrictive query', async () => {
    const page = await search('search_actors', { query: `${prefix} absent`, limit: 1 });
    expect(page).toMatchObject({ records: [], total: 0, returnedCount: 0, complete: true, nextCursor: null });
  });

  it.each([
    ['Actor', 'search_actors'], ['Item', 'search_items'],
  ] as const)('keeps a %s snapshot stable across live create, delete, rename, and replay', async (type, tool) => {
    const args = { query: prefix, limit: 100 };
    const first = await search(tool, args);
    const ids = initial.get(type)!;
    await writer().modifyDocument(type, 'delete', { ids: [ids[150]] });
    owned.get(type)!.delete(ids[150]);
    await writer().modifyDocument(type, 'update', { updates: [{ _id: ids[151], name: `${prefix} Renamed ${type}` }] });
    const [created] = await create(type, [{ name: `${prefix} Added ${type}`, type: type === 'Actor' ? 'npc' : 'loot' }]);
    const continuation = { ...args, cursor: first.nextCursor };
    const second = await search(tool, continuation);
    const replay = await search(tool, continuation);
    expect({ ...replay, readMetadata: { ...replay.readMetadata, respondedAt: second.readMetadata.respondedAt } }).toEqual(second);
    expect(second.readMetadata.freshness).toBe('stale');
    const { records } = await traverse(tool, args, first);
    expect(records.map(record => record.id)).toEqual(ids);
    expect(records.find(record => record.id === ids[151])?.name).toBe(`${prefix} Duplicate ${type}`);
    await expect.poll(async () => (await search(tool, { query: `${prefix} Added ${type}`, limit: 1 })).records.map(record => record.id)).toEqual([created]);
    const fresh = await traverse(tool, args);
    expect(fresh.pages[0].snapshotId).not.toBe(first.snapshotId);
    expect(fresh.records.map(record => record.id)).not.toContain(ids[150]);
    expect(fresh.records.find(record => record.id === ids[151])?.name).toBe(`${prefix} Renamed ${type}`);
    expect(fresh.records.map(record => record.id)).toContain(created);
  });

  it('paginates journal metadata without journal page bodies', async () => {
    const { pages, records } = await traverse('search_journals', { query: prefix, limit: 1 });
    expect(pages).toHaveLength(3);
    expect(records.map(record => record.id)).toEqual(initial.get('JournalEntry'));
    expect(records.every(record => !('pages' in record) && !('text' in record))).toBe(true);
  });

  it('uses one bounded limit across all four world document types', async () => {
    const { pages, records } = await traverse('search_world', { query: prefix, limit: 100 });
    expect(pages).toHaveLength(6);
    const expected = [...owned].flatMap(([type, ids]) => [...ids].map(id => `${type}.${id}`)).sort();
    expect(records.map(record => `${record.documentType}.${record.id}`).sort()).toEqual(expected);
    expect(new Set(records.map(record => record.documentType))).toEqual(new Set(['Actor', 'Item', 'JournalEntry', 'Scene']));
  });

  describe('collection resource traversal', () => {
    beforeAll(async () => {
      // Foundry excludes the sending socket from document change broadcasts.
      // Reconnect the fixture writer to obtain server state after its own writes.
      await foundry!.disconnect();
      foundry = await createConnectedClient({ writeEnabled: true });
    });

  it.each(['actors', 'items', 'journals', 'scenes', 'users'] as const)('follows %s resource links to every visible ID', async collection => {
    const world = foundry!.getWorldData()!;
    const records = collection === 'journals' ? world.journal : world[collection];
    const expected = records.map(record => record._id).sort();
    let uri: string | null = `foundry://${collection}?limit=100`;
    let snapshot: string | undefined;
    const ids: string[] = [];
    do {
      const response = await client().readResource({ uri });
      expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(128 * 1024);
      const content = response.contents[0];
      if (!content || !('text' in content)) throw new Error('Expected JSON resource text');
      const page = pageSchema.extend({ nextUri: z.string().nullable() }).parse(JSON.parse(content.text));
      snapshot ??= page.snapshotId;
      expect(page.snapshotId).toBe(snapshot);
      expect(page.limit).toBe(100);
      expect(page.complete).toBe(page.nextUri === null);
      ids.push(...page.records.map(record => record.id));
      uri = page.nextUri;
      if (uri) expect(new URL(uri).searchParams.get('cursor')).toBe(page.nextCursor);
    } while (uri !== null);
    expect(ids.sort()).toEqual(expected);
    expect(new Set(ids).size).toBe(ids.length);
  });

  });

  it('rejects corrupt, cross-tool, query, and limit cursor changes through live MCP', async () => {
    const first = await search('search_actors', { query: prefix, limit: 100 });
    for (const [name, args] of [
      ['search_actors', { query: prefix, limit: 100, cursor: 'corrupt' }],
      ['search_items', { query: prefix, limit: 100, cursor: first.nextCursor }],
      ['search_actors', { query: `${prefix} changed`, limit: 100, cursor: first.nextCursor }],
      ['search_actors', { query: prefix, limit: 99, cursor: first.nextCursor }],
    ] as const) await expect(client().callTool({ name, arguments: args })).rejects.toThrow();
  });

  it.each(['search_actors', 'search_items', 'search_journals', 'search_world'])('rejects invalid bounds for %s at the live MCP boundary', async name => {
    for (const args of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { cursor: '' }, { cursor: 'x'.repeat(1025) }]) {
      await expect(client().callTool({ name, arguments: args })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    }
  });
});
