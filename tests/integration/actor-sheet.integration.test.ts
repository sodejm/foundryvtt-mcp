/** Actor sections and embedded inventory through built MCP stdio and real Foundry documents. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import Ajv from 'ajv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ACTOR_SECTION_NAMES, actorItemListOutputSchema, actorItemOutputSchema,
  actorSectionOutputSchema, actorSheetOutputSchema,
} from '../../src/foundry/actor-sheet-contract.js';
import { type WorldReadMetadata, worldReadMetadataSchema } from '../../src/foundry/freshness.js';

const seedSchema = z.object({
  id: z.string(), emptyId: z.string(), otherId: z.string(), otherItemId: z.string(),
  items: z.array(z.object({ _id: z.string(), name: z.string(), type: z.string(), sort: z.number(), quantity: z.number() })),
});
type Seed = z.infer<typeof seedSchema>;

describe('live bounded actor reads through built MCP stdio', () => {
  let controlUrl: string;
  let cwd: string;
  let seed: Seed;
  let client: Client;
  let other: Client;
  const clients: Client[] = [];
  const transports: StdioClientTransport[] = [];
  const schemas = new Map<string, object>();
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
  async function control(path: string, method = 'POST') {
    const response = await fetch(controlUrl + path, { method, signal: AbortSignal.timeout(90_000) });
    if (!response.ok) throw new Error(`Actor test-world control failed (${response.status})`);
    return response.json();
  }
  async function connect() {
    const transport = new StdioClientTransport({
      command: process.execPath, args: [fileURLToPath(new URL('../../dist/index.js', import.meta.url))],
      cwd, stderr: 'pipe', env: {
        NODE_ENV: 'test', LOG_LEVEL: 'error', FOUNDRY_URL: process.env.FOUNDRY_URL!,
        FOUNDRY_USERNAME: process.env.FOUNDRY_USERNAME!, FOUNDRY_PASSWORD: process.env.FOUNDRY_PASSWORD ?? '',
        FOUNDRY_TIMEOUT: '5000', FOUNDRY_RETRY_ATTEMPTS: '0',
      },
    });
    transports.push(transport);
    transport.stderr?.on('data', () => {});
    const connected = new Client({ name: 'live-actor-sheet-integration', version: '1.0.0' });
    clients.push(connected);
    await connected.connect(transport);
    for (const tool of (await connected.listTools()).tools) if (tool.outputSchema) schemas.set(tool.name, tool.outputSchema);
    return connected;
  }
  beforeAll(async () => {
    controlUrl = process.env.FOUNDRY_ACTOR_TEST_CONTROL_URL ?? '';
    if (!controlUrl || !process.env.FOUNDRY_URL || !process.env.FOUNDRY_USERNAME) {
      throw new Error('Live actor tests require an explicit disposable-world controller and Foundry credentials');
    }
    const status = z.object({ world: z.literal('test1world'), version: z.string(), system: z.literal('dnd5e'), systemVersion: z.string() })
      .parse(await control('/status', 'GET'));
    console.info('Live actor integration versions', JSON.stringify(status));
    seed = seedSchema.parse(await control('/seed'));
    cwd = await mkdtemp(join(tmpdir(), 'foundry-live-actors-'));
    client = await connect();
    other = await connect();
  });
  afterAll(async () => {
    await Promise.allSettled([...clients.map(c => c.close()), ...transports.map(t => t.close())]);
    try { if (controlUrl) await control('/cleanup'); }
    finally { if (cwd) await rm(cwd, { recursive: true, force: true }); }
  });
  async function call(name: string, args: Record<string, unknown>, connected = client) {
    const result = CallToolResultSchema.parse(await connected.callTool({ name, arguments: args }));
    expect(ajv.validate(schemas.get(name)!, result.structuredContent), JSON.stringify(ajv.errors)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(128 * 1024);
    const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
    expect(JSON.parse(text)).toEqual(result.structuredContent);
    expect(text).not.toMatch(/NEVER_PUBLIC|ownership|flags|prototypeToken/);
    const { readMetadata } = z.object({ readMetadata: worldReadMetadataSchema }).parse(result.structuredContent);
    expect(readMetadata.freshness).not.toBe('unavailable');
    if (args.cursor === undefined) expect(readMetadata.freshness).toBe('current');
    return result.structuredContent;
  }
  async function inventory(args: Record<string, unknown> = {}) {
    return actorItemListOutputSchema.parse(await call('list_actor_items', { actorId: seed.id, ...args }));
  }
  async function item(itemId: string) {
    return actorItemOutputSchema.parse(await call('get_actor_item', { actorId: seed.id, itemId }));
  }
  function source(metadata: WorldReadMetadata) {
    const { freshness: _freshness, respondedAt: _respondedAt, ...captured } = metadata;
    return captured;
  }
  async function allItems(limit: number) {
    const first = await inventory({ limit });
    const records = [...first.records];
    let page = first;
    while (page.nextCursor) {
      page = await inventory({ limit, cursor: page.nextCursor });
      expect(page.snapshotId).toBe(first.snapshotId);
      expect(source(page.readMetadata)).toEqual(source(first.readMetadata));
      expect(page.total).toBe(first.total);
      records.push(...page.records);
    }
    expect(page).toMatchObject({ complete: true, nextCursor: null });
    expect(new Set(records.map(record => record.id)).size).toBe(first.total);
    return records;
  }

  it('describes the real DND5E actor and all addressable sections', async () => {
    const sheet = actorSheetOutputSchema.parse(await call('get_actor_sheet', { actorId: seed.id }));
    expect(sheet).toMatchObject({ actor: { id: seed.id, uuid: `Actor.${seed.id}`, type: 'npc' },
      system: { id: 'dnd5e', version: '6.0.6', profile: 'dnd5e' }, itemCount: 251 });
    expect(sheet.sections.map(section => section.name)).toEqual(ACTOR_SECTION_NAMES);
    for (const name of ACTOR_SECTION_NAMES) {
      const section = actorSectionOutputSchema.parse(await call('get_actor_section', { actorId: seed.id, section: name }));
      const descriptor = sheet.sections.find(entry => entry.name === name)!;
      expect(section).toMatchObject({ supported: descriptor.supported, section: name });
      expect(section.fields).toHaveLength(descriptor.fieldCount);
      for (const field of section.fields) {
        expect(field.source).toBe('normalized');
        expect(field.path).toMatch(/^system\./);
        if (!field.present) expect(field).not.toHaveProperty('value');
        if (typeof field.value === 'string') expect(field.value.length).toBeLessThanOrEqual(4096);
      }
      if (name === 'attributes') expect(section.fields.find(field => field.key === 'hp.value')).toMatchObject({ present: true, value: 0 });
      if (name === 'currency') expect(section.fields.find(field => field.key === 'currency.gp')).toMatchObject({ present: true, value: 0 });
      if (name === 'details') expect(section.fields.find(field => field.key === 'level')).toMatchObject({ present: false });
    }
  });
  it.each([10, 100])('traverses all 251 items with stable IDs, UUIDs and ordering at limit %i', async limit => {
    const records = await allItems(limit);
    const expected = seed.items.map(entry => ({ ...entry, name: entry.name.slice(0, 512).replace(/[\uD800-\uDBFF]$/, '') }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a._id.localeCompare(b._id));
    expect(records.map(record => record.id)).toEqual(expected.map(entry => entry._id));
    for (const record of records) {
      const fixture = expected.find(entry => entry._id === record.id)!;
      expect(record).toMatchObject({ name: fixture.name, type: fixture.type, quantity: fixture.quantity,
        uuid: `Actor.${seed.id}.Item.${record.id}` });
    }
    expect(records.filter(record => record.name === 'Duplicate Gear 😀')).toHaveLength(2);
  });
  it('supports a one-item page, replay, filters and a complete empty inventory', async () => {
    const first = await inventory({ limit: 1 });
    expect(first).toMatchObject({ total: 251, returnedCount: 1, complete: false });
    const second = await inventory({ limit: 1, cursor: first.nextCursor });
    const replay = await inventory({ limit: 1, cursor: first.nextCursor });
    expect(replay.records).toEqual(second.records);
    expect(await inventory({ query: 'DUPLICATE', type: 'LOOT' })).toMatchObject({ total: 2 });
    expect(await inventory({ query: 'no matching item' })).toMatchObject({ total: 0, records: [], complete: true, nextCursor: null });
    expect(await inventory({ actorId: seed.emptyId })).toMatchObject({ total: 0, records: [], complete: true, nextCursor: null });
  });
  it('reads each embedded item by its parent and bounds long and unusual content', async () => {
    for (const fixture of [seed.items[0]!, seed.items[1]!, seed.items[250]!]) {
      const result = await item(fixture._id);
      expect(result.item).toMatchObject({ id: fixture._id, parentActorId: seed.id,
        uuid: `Actor.${seed.id}.Item.${fixture._id}`, quantity: fixture.quantity, systemFieldsSupported: true });
      expect(result.item.name.length).toBeLessThanOrEqual(512);
      expect(result.item.name.isWellFormed()).toBe(true);
      if (fixture === seed.items[0]) {
        expect(result.item.fields.find(field => field.key === 'quantity')).toMatchObject({ present: true, value: 0 });
        expect(result.item.fields.find(field => field.key === 'description')).toMatchObject({ present: true, truncated: true });
      }
    }
  });
  it.each([
    ['get_actor_sheet', {}], ['get_actor_section', { section: 'attributes' }],
    ['list_actor_items', {}], ['get_actor_item', { itemId: 'AAAAAAAAAAAAAAAA' }],
  ])('%s rejects missing actors and strict malformed inputs', async (name, extra) => {
    for (const actorId of ['bad', 'Actor.AAAAAAAAAAAAAAAA']) {
      await expect(client.callTool({ name: String(name), arguments: { ...extra, actorId } })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    }
    await expect(client.callTool({ name: String(name), arguments: { ...extra, actorId: 'AAAAAAAAAAAAAAAA' } })).rejects.toMatchObject({ code: ErrorCode.InternalError });
    await expect(client.callTool({ name: String(name), arguments: { ...extra, actorId: seed.id, unexpected: true } })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });
  it('rejects invalid sections, item IDs, limits, filters and cursor values', async () => {
    for (const section of ['unknown', '', 'Attributes', 0]) {
      await expect(client.callTool({ name: 'get_actor_section', arguments: { actorId: seed.id, section } })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    }
    for (const itemId of ['bad', 'Item.AAAAAAAAAAAAAAAA']) {
      await expect(client.callTool({ name: 'get_actor_item', arguments: { actorId: seed.id, itemId } })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    }
    for (const args of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { query: 'x'.repeat(1025) }, { type: 'x'.repeat(129) }, { cursor: '' }]) {
      await expect(client.callTool({ name: 'list_actor_items', arguments: { actorId: seed.id, ...args } })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    }
    for (const [actorId, itemId] of [[seed.id, seed.otherItemId], [seed.otherId, seed.items[0]!._id], [seed.id, 'AAAAAAAAAAAAAAAA']]) {
      await expect(client.callTool({ name: 'get_actor_item', arguments: { actorId, itemId } })).rejects.toMatchObject({ code: ErrorCode.InternalError });
    }
  });
  it('binds inventory cursors to actor, filters, limit, tool and MCP session', async () => {
    const first = await inventory({ limit: 1 });
    const cursor = first.nextCursor!;
    for (const [connected, name, args] of [
      [client, 'list_actor_items', { actorId: seed.emptyId, limit: 1, cursor }],
      [client, 'list_actor_items', { actorId: seed.id, limit: 2, cursor }],
      [client, 'list_actor_items', { actorId: seed.id, limit: 1, query: 'Gear', cursor }],
      [client, 'list_actor_items', { actorId: seed.id, limit: 1, type: 'loot', cursor }],
      [other, 'list_actor_items', { actorId: seed.id, limit: 1, cursor }],
      [client, 'list_actor_items', { actorId: seed.id, limit: 1, cursor: cursor.slice(0, -2) + 'xx' }],
    ] as const) {
      await expect(connected.callTool({ name, arguments: args })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    }
    await expect(client.callTool({ name: 'search_items', arguments: { limit: 1, cursor } }))
      .rejects.toMatchObject({ code: ErrorCode.InternalError });
    expect((await inventory({ limit: 1, cursor })).page).toBe(2);
  });
  it.each(['item-edit', 'item-sort', 'item-delete'])('invalidates inventory after real %s broadcasts', async kind => {
    const target = seed.items[kind === 'item-delete' ? 2 : 0]!;
    const first = await inventory({ limit: 1 });
    await control(`/mutate?kind=${kind}&actorId=${seed.id}&itemId=${target._id}`);
    await expect.poll(async () => {
      try { await inventory({ limit: 1, cursor: first.nextCursor }); return false; }
      catch (error) { return (error as { code: number }).code === ErrorCode.InvalidParams; }
    }, { timeout: 10_000 }).toBe(true);
    if (kind === 'item-edit') {
      expect((await item(target._id)).item.quantity).toBe(42);
    } else if (kind === 'item-delete') {
      expect((await inventory()).total).toBe(250);
      await expect(client.callTool({ name: 'get_actor_item', arguments: { actorId: seed.id, itemId: target._id } })).rejects.toMatchObject({ code: ErrorCode.InternalError });
    } else {
      expect((await inventory()).records[0]?.id).toBe((await allItems(100))[0]?.id);
    }
  });
  it('reports current actor edits and rejects all surfaces after deletion', async () => {
    await control(`/mutate?kind=actor-edit&actorId=${seed.id}`);
    await expect.poll(async () => {
      const section = actorSectionOutputSchema.parse(await call('get_actor_section', { actorId: seed.id, section: 'attributes' }));
      return section.fields.find(field => field.key === 'hp.value')?.value;
    }, { timeout: 10_000 }).toBe(5);
    await control(`/mutate?kind=actor-delete&actorId=${seed.id}`);
    await expect.poll(async () => {
      try { await call('get_actor_sheet', { actorId: seed.id }); return false; }
      catch (error) { return (error as { code: number }).code === ErrorCode.InternalError; }
    }, { timeout: 10_000 }).toBe(true);
    for (const [name, args] of [
      ['get_actor_sheet', {}], ['get_actor_section', { section: 'attributes' }],
      ['list_actor_items', {}], ['get_actor_item', { itemId: seed.items[0]!._id }],
    ] as const) {
      await expect(client.callTool({ name, arguments: { actorId: seed.id, ...args } })).rejects.toMatchObject({ code: ErrorCode.InternalError });
    }
  });
});
