/** Real DND5E economy reads, filtering and updates through the built MCP server. */
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
  actorItemListOutputSchema,
  actorItemOutputSchema,
} from '../../src/foundry/actor-sheet-contract.js';
import { itemDetailsSchema, itemSearchSchema } from '../../src/foundry/read-contract.js';

const seedSchema = z.object({
  actorId: z.string(),
  items: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      type: z.string(),
      price: z.object({ value: z.number(), denomination: z.string() }),
      rarities: z.array(z.string()),
    }),
  ),
  owned: z.array(z.object({ id: z.string(), worldId: z.string() })),
});
describe('live versioned item economy through built MCP stdio', () => {
  let controlUrl: string;
  let cwd: string;
  let seed: z.infer<typeof seedSchema>;
  let client: Client;
  let transport: StdioClientTransport;
  const schemas = new Map<string, object>();
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
  async function control(path: string, method = 'POST') {
    const response = await fetch(controlUrl + path, {
      method,
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) throw new Error(`Item fixture operation failed (${response.status})`);
    return response.json();
  }
  beforeAll(async () => {
    controlUrl = process.env.FOUNDRY_ITEM_TEST_CONTROL_URL ?? '';
    if (!controlUrl || !process.env.FOUNDRY_URL || !process.env.FOUNDRY_USERNAME)
      throw new Error('Explicit disposable-world controller and Foundry credentials are required');
    const status = z
      .object({
        world: z.literal('test1world'),
        version: z.string(),
        system: z.literal('dnd5e'),
        systemVersion: z.literal('6.0.6'),
      })
      .parse(await control('/status', 'GET'));
    console.info('Live item integration versions', JSON.stringify(status));
    seed = seedSchema.parse(await control('/seed'));
    expect(seed.items.map((item) => item.name)).toEqual(
      Array.from({ length: 251 }, (_, index) =>
        `MCPItemIssue13 Gear ${String(index).padStart(3, '0')}`,
      ),
    );
    expect(new Set(seed.items.map((item) => item.id)).size).toBe(251);
    expect(seed.items[250]!.type).toBe('tool');
    cwd = await mkdtemp(join(tmpdir(), 'foundry-live-economy-'));
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('../../dist/index.js', import.meta.url))],
      cwd,
      stderr: 'pipe',
      env: {
        NODE_ENV: 'test',
        LOG_LEVEL: 'error',
        FOUNDRY_URL: process.env.FOUNDRY_URL!,
        FOUNDRY_USERNAME: process.env.FOUNDRY_USERNAME!,
        FOUNDRY_PASSWORD: process.env.FOUNDRY_PASSWORD ?? '',
        FOUNDRY_TIMEOUT: '5000',
        FOUNDRY_RETRY_ATTEMPTS: '0',
      },
    });
    transport.stderr?.on('data', () => {});
    client = new Client({ name: 'live-item-economy-integration', version: '1.0.0' });
    await client.connect(transport);
    for (const tool of (await client.listTools()).tools)
      if (tool.outputSchema) schemas.set(tool.name, tool.outputSchema);
  });
  afterAll(async () => {
    await Promise.allSettled([client?.close(), transport?.close()]);
    try {
      if (controlUrl) expect(await control('/cleanup')).toEqual({ remaining: 0 });
    } finally {
      if (cwd) await rm(cwd, { recursive: true, force: true });
    }
  });
  async function call(name: string, args: Record<string, unknown>) {
    const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
    expect(
      ajv.validate(schemas.get(name)!, result.structuredContent),
      JSON.stringify(ajv.errors),
    ).toBe(true);
    expect(JSON.stringify(result.structuredContent)).not.toMatch(
      /NEVER_PUBLIC|ownership|flags|prototypeToken/,
    );
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(128 * 1024);
    return result;
  }
  async function search(args: Record<string, unknown> = {}) {
    return itemSearchSchema.parse(
      (await call('search_items', { query: 'MCPItemIssue13', ...args })).structuredContent,
    );
  }
  async function detail(id: string) {
    return itemDetailsSchema.parse(
      (await call('get_item_details', { itemId: id })).structuredContent,
    ).record;
  }
  it('preserves source values, zero, fractional silver and multiple rarities without guesses', async () => {
    for (const index of [0, 1, 250]) {
      const fixture = seed.items[index]!;
      const record = await detail(fixture.id);
      expect(record).toMatchObject({
        id: fixture.id,
        uuid: `Item.${fixture.id}`,
        price: fixture.price,
        economy: {
          schemaVersion: 1,
          adapter: {
            systemId: 'dnd5e',
            systemVersion: '6.0.6',
            status: 'supported',
            adapterId: 'dnd5e@6.0.6',
          },
          source: { price: fixture.price, rarities: fixture.rarities },
          price: { status: 'known', currencies: [fixture.price], per: null },
          rarity: { status: 'known', values: fixture.rarities },
        },
      });
      expect(record).not.toHaveProperty('system');
      if (fixture.rarities.length === 1) expect(record.rarity).toBe(fixture.rarities[0]);
      else expect(record).not.toHaveProperty('rarity');
    }
    const zero = await call('get_item_details', { itemId: seed.items[0]!.id });
    expect(zero.content.some((block) => block.type === 'text' && block.text.includes('0 gp'))).toBe(
      true,
    );
  });
  it('uses the same economy for world and owned items while retaining parent identity', async () => {
    const inventory = actorItemListOutputSchema.parse(
      (await call('list_actor_items', { actorId: seed.actorId })).structuredContent,
    );
    expect(inventory.schemaVersion).toBe(2);
    expect(inventory.total).toBe(3);
    for (const owned of seed.owned) {
      const world = await detail(owned.worldId);
      const item = actorItemOutputSchema.parse(
        (await call('get_actor_item', { actorId: seed.actorId, itemId: owned.id }))
          .structuredContent,
      ).item;
      expect(item).toMatchObject({
        id: owned.id,
        parentActorId: seed.actorId,
        uuid: `Actor.${seed.actorId}.Item.${owned.id}`,
      });
      expect(item.economy, JSON.stringify({ owned: item.economy, world: world.economy })).toEqual(
        world.economy,
      );
      expect(inventory.records.find((record) => record.id === owned.id)?.economy).toEqual(
        world.economy,
      );
      expect(item.fields.map((field) => field.key)).not.toContain('price');
      expect(item.fields.map((field) => field.key)).not.toContain('rarity');
    }
  });
  it.each([
    'common',
    'RARE',
  ])('applies rarity before paging with complete filtered totals for %s', async (rarity) => {
    const expected = seed.items.filter((item) =>
      item.rarities.some((value) => value.toLowerCase() === rarity.toLowerCase()),
    );
    let page = await search({ rarity, limit: 100 });
    const first = page;
    const ids = page.records.map((record) => record.id);
    expect(page.total).toBe(expected.length);
    expect(page.records).toHaveLength(100);
    while (page.nextCursor) {
      const args = { rarity, limit: 100, cursor: page.nextCursor };
      page = await search(args);
      expect((await search(args)).records).toEqual(page.records);
      expect(page.snapshotId).toBe(first.snapshotId);
      expect(page.total).toBe(expected.length);
      ids.push(...page.records.map((record) => record.id));
    }
    expect(page).toMatchObject({ complete: true, nextCursor: null });
    expect(new Set(ids)).toEqual(new Set(expected.map((item) => item.id)));
  });
  it('combines name, type and rarity filters and reports an honest empty result', async () => {
    const filtered = await search({
      query: 'MCPItemIssue13 GEAR',
      type: 'TOOL',
      rarity: 'veryrare',
    });
    expect(filtered, JSON.stringify(filtered)).toMatchObject({
      total: 1,
      records: [{ id: seed.items[250]!.id }],
    });
    expect(await search({ type: 'tool', rarity: 'common' })).toMatchObject({
      total: 0,
      records: [],
      complete: true,
    });
    expect(await search({ query: 'MCPItemIssue13 absent', rarity: 'rare' })).toMatchObject({
      total: 0,
    });
  });
  it('rejects unsupported canonical filters, cursor rebinding and malformed or missing IDs', async () => {
    for (const rarity of ['unknown', 'localized-rare', 'unique'])
      await expect(
        client.callTool({ name: 'search_items', arguments: { rarity } }),
      ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    const first = await search({ rarity: 'rare', limit: 1 });
    await expect(
      client.callTool({
        name: 'search_items',
        arguments: {
          query: 'MCPItemIssue13',
          rarity: 'common',
          limit: 1,
          cursor: first.nextCursor,
        },
      }),
    ).rejects.toMatchObject({ code: ErrorCode.InternalError });
    for (const itemId of ['bad', 'Item.AAAAAAAAAAAAAAAA'])
      await expect(
        client.callTool({ name: 'get_item_details', arguments: { itemId } }),
      ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(
      client.callTool({ name: 'get_item_details', arguments: { itemId: 'AAAAAAAAAAAAAAAA' } }),
    ).rejects.toMatchObject({ code: ErrorCode.InternalError });
  });
  it('refreshes real price and rarity updates, retains immutable traversals and reads owned edits', async () => {
    const first = await search({ limit: 1 });
    const target = seed.items[0]!;
    await control(`/mutate?kind=world-edit&itemId=${target.id}`);
    await expect
      .poll(async () => (await detail(target.id)).price, { timeout: 10_000 })
      .toEqual({ value: 25, denomination: 'cp' });
    expect((await detail(target.id)).economy.rarity).toEqual({
      status: 'known',
      values: ['veryRare'],
    });
    const continuation = await search({ limit: 1, cursor: first.nextCursor });
    expect(continuation.snapshotId).toBe(first.snapshotId);
    expect(continuation.total).toBe(first.total);
    const owned = seed.owned[0]!;
    await control(`/mutate?kind=owned-edit&actorId=${seed.actorId}&itemId=${owned.id}`);
    await expect
      .poll(
        async () =>
          actorItemOutputSchema.parse(
            (await call('get_actor_item', { actorId: seed.actorId, itemId: owned.id }))
              .structuredContent,
          ).item.economy,
        { timeout: 10_000 },
      )
      .toEqual((await detail(target.id)).economy);
  });
  it('removes a real item and reports its absence on subsequent reads', async () => {
    const target = seed.items[1]!;
    await control(`/mutate?kind=world-delete&itemId=${target.id}`);
    await expect
      .poll(async () => (await search({ limit: 100 })).total, { timeout: 10_000 })
      .toBe(250);
    await expect(
      client.callTool({ name: 'get_item_details', arguments: { itemId: target.id } }),
    ).rejects.toMatchObject({ code: ErrorCode.InternalError });
  });
});
