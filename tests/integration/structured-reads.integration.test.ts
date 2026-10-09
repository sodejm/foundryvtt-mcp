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
import { createConnectedClient } from './setup.js';

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
  let mcp: Client | undefined;
  let transport: StdioClientTransport | undefined;
  let actorPair: FixturePair;
  let itemPair: FixturePair;
  let missingId: string;
  let serverStderr = '';
  const schemas = new Map<string, object>();
  const ajv = new Ajv({ allErrors: true, strict: false });

  beforeAll(async () => {
    foundry = await createConnectedClient();
    const world = foundry.getWorldData();
    if (!world) throw new Error('A bootstrapped Socket.IO world is required');

    actorPair = selectFixturePair(
      world.actors, 'actor',
      process.env.FOUNDRY_TEST_ACTOR_NAME,
      process.env.FOUNDRY_TEST_ACTOR_IDS,
    );
    itemPair = selectFixturePair(
      world.items, 'item',
      process.env.FOUNDRY_TEST_ITEM_NAME,
      process.env.FOUNDRY_TEST_ITEM_IDS,
    );
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
    await Promise.allSettled([mcp?.close(), transport?.close(), foundry?.disconnect()]);
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
    expect(metadata).toMatchObject({ source: 'socket', freshness: 'current', worldId: 'test1world' });
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

  for (const fixture of deletedFixtures()) {
    it(`reports the explicitly deleted ${fixture.documentType} fixture as missing`, async () => {
      await expect(connectedMcp().callTool({
        name: fixture.tool,
        arguments: { [fixture.argument]: fixture.id },
      })).rejects.toThrow();
    });
  }
});

function selectFixturePair<T extends FixtureDocument>(
  records: T[],
  kind: string,
  expectedName: string | undefined,
  explicitIds: string | undefined,
): readonly [T, T] {
  const ids = parseIds(explicitIds, `${kind} fixture IDs`);
  if (ids) {
    if (ids.length !== 2) throw new Error(`${kind} fixture IDs must contain exactly two IDs`);
    const selected = ids.map(id => records.find(record => record._id === id));
    if (selected.some(record => !record)) {
      throw new Error(`${kind} fixture IDs were not all present in the live world`);
    }
    const pair = selected as [T, T];
    if (pair[0].name !== pair[1].name) {
      throw new Error(`Explicit ${kind} fixtures must have the same name`);
    }
    if (expectedName !== undefined && pair.some(record => record.name !== expectedName)) {
      throw new Error(`Explicit ${kind} fixtures do not match FOUNDRY_TEST_${kind.toUpperCase()}_NAME`);
    }
    return pair;
  }

  if (expectedName !== undefined) {
    const matches = records.filter(record => record.name === expectedName);
    if (matches.length !== 2) {
      throw new Error(`Expected exactly two ${kind} fixtures named ${JSON.stringify(expectedName)}, found ${matches.length}`);
    }
    return matches as [T, T];
  }

  const groups = new Map<string, T[]>();
  for (const record of records) {
    const group = groups.get(record.name) ?? [];
    group.push(record);
    groups.set(record.name, group);
  }
  const pair = [...groups.values()].find(group => group.length === 2);
  if (!pair) throw new Error(`Live fixture requires exactly two same-name ${kind} documents`);
  return pair as [T, T];
}

function parseIds(value: string | undefined, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  const ids = value.split(/[\s,]+/).filter(Boolean);
  if (ids.some(id => !foundryId.test(id))) {
    throw new Error(`${label} must be 16-character alphanumeric Foundry IDs`);
  }
  return ids;
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

function deletedFixtures(): Array<{
  documentType: 'actor' | 'item';
  tool: 'get_actor_details' | 'get_item_details';
  argument: 'actorId' | 'itemId';
  id: string;
}> {
  const configured = [
    ['actor', 'get_actor_details', 'actorId', process.env.FOUNDRY_TEST_DELETED_ACTOR_ID],
    ['item', 'get_item_details', 'itemId', process.env.FOUNDRY_TEST_DELETED_ITEM_ID],
  ] as const;
  return configured.flatMap(([documentType, tool, argument, id]) => {
    if (id === undefined) return [];
    if (!foundryId.test(id)) {
      throw new Error(`FOUNDRY_TEST_DELETED_${documentType.toUpperCase()}_ID must be a 16-character alphanumeric Foundry ID`);
    }
    return [{ documentType, tool, argument, id }];
  });
}
