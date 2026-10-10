/**
 * Live read-contract checks through the actual MCP stdio entry point.
 * Missing services or fixtures fail setup; this suite never converts them into skips.
 */
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import Ajv from 'ajv';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FoundryClient } from '../../src/foundry/client.js';
import { worldReadMetadataSchema } from '../../src/foundry/freshness.js';
import type { WorldActor, WorldItem } from '../../src/foundry/types.js';
import { WorldFixture } from './world-fixture.js';

const fixtureRecord = z.object({
  id: z.string(),
  documentType: z.enum(['Actor', 'Item']),
  name: z.string(),
  type: z.string(),
  uuid: z.string().optional(),
}).passthrough();
const searchEnvelope = z.object({
  schemaVersion: z.union([z.literal(3), z.literal(4)]),
  records: z.array(fixtureRecord),
  readMetadata: worldReadMetadataSchema,
}).passthrough();
const detailEnvelope = z.object({
  schemaVersion: z.union([z.literal(2), z.literal(3)]),
  record: fixtureRecord,
  readMetadata: worldReadMetadataSchema,
}).passthrough();
const foundryId = /^[A-Za-z0-9]{16}$/;

type FixtureDocument = WorldActor | WorldItem;
type FixturePair = readonly [FixtureDocument, FixtureDocument];

describe('live structured actor/item reads through MCP stdio', () => {
  let foundry: FoundryClient | undefined;
  let fixture: WorldFixture | undefined;
  let worldId: string;
  let deletedActorId: string;
  let deletedItemId: string;
  let mcp: Client | undefined;
  let transport: StdioClientTransport | undefined;
  let actorPair: FixturePair;
  let itemPair: FixturePair;
  let missingId: string;
  let serverStderr = '';
  const schemas = new Map<string, object>();
  const ajv = new Ajv({ allErrors: true, strict: false });

  beforeAll(async () => {
    fixture = await WorldFixture.connect();
    foundry = fixture.client;
    const actorData = {
      name: `${fixture.prefix} Duplicate Actor`, type: 'npc',
      system: { attributes: { hp: { value: 0, max: 0, temp: 0 } }, details: { biography: { value: '' } } },
    };
    const itemData = {
      name: `${fixture.prefix} Duplicate Item`, type: 'weapon',
      system: { description: { value: '' }, price: { value: 0, denomination: 'gp' },
        weight: { value: 0 }, quantity: 0, identified: false },
    };
    const actorIds = [(await fixture.create('Actor', actorData))._id,
      (await fixture.create('Actor', actorData))._id];
    const itemIds = [(await fixture.create('Item', itemData))._id,
      (await fixture.create('Item', itemData))._id];
    deletedActorId = (await fixture.create('Actor', { ...actorData, name: `${fixture.prefix} Deleted Actor` }))._id;
    deletedItemId = (await fixture.create('Item', { ...itemData, name: `${fixture.prefix} Deleted Item` }))._id;
    await fixture.delete('Actor', deletedActorId);
    await fixture.delete('Item', deletedItemId);
    await foundry.refreshWorldData();
    const world = foundry.getWorldData();
    if (!world) throw new Error('A bootstrapped Socket.IO world is required');
    worldId = world.world.id;
    actorPair = ownedPair(world.actors, actorIds);
    itemPair = ownedPair(world.items, itemIds);
    missingId = selectMissingId(world.actors, world.items, process.env.FOUNDRY_TEST_MISSING_ID);

    // Record only runtime identity/version evidence, never world documents.
    console.info('Live structured-read version evidence', JSON.stringify({
      release: selectFields(world.release, ['generation', 'version', 'build']),
      system: selectFields(world.system, ['id', 'title', 'version']),
      modules: world.modules.map(module =>
        selectFields(module, ['id', 'title', 'version', 'active'])),
    }));

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url)),
        fileURLToPath(new URL('../../src/index.ts', import.meta.url)),
      ],
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      stderr: 'pipe',
      env: mcpEnvironment(),
    });
    // Drain stderr so the child cannot block, while retaining bounded startup diagnostics.
    transport.stderr?.on('data', chunk => {
      serverStderr = `${serverStderr}${String(chunk)}`.slice(-8_000);
    });
    mcp = new Client({ name: 'live-structured-read-integration', version: '1.0.0' });
    try {
      await mcp.connect(transport);
    } catch (error) {
      const diagnostics = redactConfiguredSecrets(serverStderr).trim();
      throw new Error(
        diagnostics === '' ? 'The MCP stdio server exited during startup'
          : `The MCP stdio server exited during startup:\n${diagnostics}`,
        { cause: error },
      );
    }
    const listed = await mcp.listTools();
    for (const tool of listed.tools) {
      if (tool.outputSchema) schemas.set(tool.name, tool.outputSchema);
    }
  });

  afterAll(async () => {
    const results = await Promise.allSettled([mcp?.close(), transport?.close(), fixture?.close()]);
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length > 0) throw new AggregateError(errors, 'Structured-read fixture cleanup failed');
  });

  function connectedMcp(): Client {
    if (!mcp) throw new Error('The MCP stdio client was not established');
    return mcp;
  }

  async function call(name: string, args: Record<string, unknown>) {
    const result = CallToolResultSchema.parse(
      await connectedMcp().callTool({ name, arguments: args }),
    );
    const schema = schemas.get(name);
    expect(schema, `${name} advertises an output schema`).toBeDefined();
    expect(
      ajv.validate(schema!, result.structuredContent),
      `${name}: ${JSON.stringify(ajv.errors)}`,
    ).toBe(true);
    const text = result.content.flatMap(block =>
      block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n');
    const metadata = worldReadMetadataSchema.parse(result.structuredContent?.readMetadata);
    expect(metadata).toMatchObject({ source: 'socket', freshness: 'current', worldId });
    expect(metadata.snapshotId).not.toBeNull();
    expect(metadata.capturedAt).not.toBeNull();
    expect(metadata.observedAt).not.toBeNull();
    expect(text).toContain(metadata.sessionId);
    return { structured: result.structuredContent, text };
  }

  it('publishes all four output schemas and each rejects an invalid envelope', () => {
    for (const name of ['search_actors', 'get_actor_details', 'search_items', 'get_item_details']) {
      const schema = schemas.get(name);
      expect(schema, `${name} output schema`).toBeDefined();
      expect(ajv.validate(schema!, { schemaVersion: 999 })).toBe(false);
    }
  });

  it.each([
    ['Actor', 'search_actors', 'get_actor_details', 'actorId', () => actorPair],
    ['Item', 'search_items', 'get_item_details', 'itemId', () => itemPair],
  ] as const)(
    'selects both duplicate-name %s documents through MCP search and detail',
    async (documentType, searchTool, detailTool, idArgument, pairValue) => {
      const pair = pairValue();
      const search = await call(searchTool, { query: pair[0].name, limit: 100 });
      const records = searchEnvelope.parse(search.structured).records;

      for (const source of pair) {
        const selected = records.find(record => record.id === source._id);
        expect(selected, `${documentType} ${source._id} appears in search`).toBeDefined();
        expect(selected).toMatchObject({
          documentType,
          id: source._id,
          name: source.name,
          type: source.type,
          uuid: `${documentType}.${source._id}`,
        });
        expectTextParity(search.text, selected!);

        const detail = await call(detailTool, { [idArgument]: source._id });
        const resolved = detailEnvelope.parse(detail.structured).record;
        expect(resolved).toEqual(selected);
        expectTextParity(detail.text, resolved);
      }
    },
  );

  it('preserves live zero, false, and empty-string values through MCP detail reads', async () => {
    const actor = await call('get_actor_details', { actorId: actorPair[0]._id });
    expect(detailEnvelope.parse(actor.structured).record).toMatchObject({
      hp: { value: 0, max: 0, temp: 0 },
      biography: '',
    });
    expect(actor.text).toContain('**Hit Points:** 0/0');

    const item = await call('get_item_details', { itemId: itemPair[0]._id });
    expect(detailEnvelope.parse(item.structured).record).toMatchObject({
      description: '',
      price: { value: 0, denomination: 'gp' },
      weight: 0,
      quantity: 0,
      identified: false,
    });
    expect(item.text).toContain('**Price:** 0 gp');
    expect(item.text).toContain('**Weight:** 0');
    expect(item.text).toContain('**Quantity:** 0');
    expect(item.text).toContain('**Identified:** false');
  });

  it.each(['', '../escape', 'Actor.aaaaaaaaaaaaaaaa', 'short', 42, null])(
    'rejects invalid detail ID %j at the MCP boundary',
    async id => {
      await expect(connectedMcp().callTool({
        name: 'get_actor_details', arguments: { actorId: id },
      })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
      await expect(connectedMcp().callTool({
        name: 'get_item_details', arguments: { itemId: id },
      })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    },
  );

  it('reports valid but missing actor and item IDs as errors', async () => {
    await expect(connectedMcp().callTool({
      name: 'get_actor_details', arguments: { actorId: missingId },
    })).rejects.toThrow();
    await expect(connectedMcp().callTool({
      name: 'get_item_details', arguments: { itemId: missingId },
    })).rejects.toThrow();
  });

  it.each([
    ['actor', 'get_actor_details', 'actorId', () => deletedActorId],
    ['item', 'get_item_details', 'itemId', () => deletedItemId],
  ] as const)('reports the deleted owned %s fixture as missing', async (_, tool, argument, id) => {
    await expect(connectedMcp().callTool({ name: tool, arguments: { [argument]: id() } })).rejects.toThrow();
  });
});

function ownedPair<T extends FixtureDocument>(records: T[], ids: string[]): readonly [T, T] {
  const pair = ids.map(id => records.find(record => record._id === id));
  if (pair.length !== 2 || pair.some(record => !record)) {
    throw new Error('Owned duplicate-name fixtures were not present in the live world');
  }
  return pair as [T, T];
}

function selectMissingId(
  actors: WorldActor[],
  items: WorldItem[],
  explicitId: string | undefined,
): string {
  const candidates = explicitId === undefined
    ? ['0000000000000000', '1111111111111111', '2222222222222222']
    : [explicitId];
  if (candidates.some(id => !foundryId.test(id))) {
    throw new Error('FOUNDRY_TEST_MISSING_ID must be a 16-character alphanumeric Foundry ID');
  }
  const missing = candidates.find(id =>
    !actors.some(record => record._id === id) && !items.some(record => record._id === id));
  if (!missing) throw new Error('No configured negative-test ID is absent from the live world');
  return missing;
}

function selectFields(
  source: Record<string, unknown>,
  fields: string[],
): Record<string, unknown> {
  return Object.fromEntries(fields.flatMap(field =>
    source[field] === undefined ? [] : [[field, source[field]]]));
}

function mcpEnvironment(): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return {
    ...environment,
    NODE_ENV: 'test',
    LOG_LEVEL: process.env.LOG_LEVEL ?? 'error',
    FOUNDRY_URL: process.env.FOUNDRY_URL ?? 'http://127.0.0.1:30001',
    FOUNDRY_USERNAME: process.env.FOUNDRY_USERNAME ?? 'Gamemaster',
    FOUNDRY_PASSWORD: process.env.FOUNDRY_PASSWORD ?? '',
  };
}

function expectTextParity(text: string, record: z.infer<typeof fixtureRecord>): void {
  for (const value of [record.documentType, record.id, record.name, record.type]) {
    if (value !== '') expect(text).toContain(value);
  }
}

function redactConfiguredSecrets(value: string): string {
  return ['FOUNDRY_PASSWORD', 'FOUNDRY_API_KEY'].reduce((redacted, name) => {
    const secret = process.env[name];
    return secret ? redacted.replaceAll(secret, '[REDACTED]') : redacted;
  }, value);
}
