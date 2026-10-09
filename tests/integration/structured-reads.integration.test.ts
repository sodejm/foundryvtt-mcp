/** Live read-contract checks. A fixture with duplicate actor/item names is required;
 * missing data is a failed precondition, never a skipped or passing test. */
import Ajv from 'ajv';
import { ErrorCode, ToolSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FoundryClient } from '../../src/foundry/client.js';
import { getAllTools } from '../../src/tools/definitions.js';
import { handleGetActorDetails, handleSearchActors } from '../../src/tools/handlers/actors.js';
import { handleGetItemDetails, handleSearchItems } from '../../src/tools/handlers/items.js';
import { createConnectedClient } from './setup.js';

describe('live structured actor/item reads (required fixture)', () => {
  let client: FoundryClient | undefined;
  const ajv = new Ajv({ strict: false });

  beforeAll(async () => {
    client = await createConnectedClient();
    const world = client.getWorldData();
    expect(world, 'A bootstrapped Socket.IO world is required').not.toBeNull();
    expect(world?.release).toBeDefined();
    expect(world?.system).toBeDefined();
    // Deliberately record version evidence only, never user/session documents.
    console.info('Live structured-read version evidence', JSON.stringify({
      release: world?.release,
      system: world?.system,
      modules: world?.modules,
    }));
  });

  afterAll(async () => { await client?.disconnect(); });

  function connectedClient(): FoundryClient {
    if (!client) throw new Error('Live Foundry connection was not established');
    return client;
  }

  function duplicatePair<T extends { _id: string; name: string }>(records: T[], kind: string): T[] {
    const names = new Map<string, T[]>();
    for (const record of records) {
      const group = names.get(record.name) ?? [];
      group.push(record);
      names.set(record.name, group);
    }
    const group = [...names.values()].find(records => records.length === 2);
    if (!group) throw new Error(`Live fixture requires exactly two same-name ${kind} documents`);
    return group;
  }

  function validate(name: string, data: unknown): void {
    const tool = ToolSchema.parse(getAllTools().find(tool => tool.name === name));
    if (!tool.outputSchema) throw new Error(`${name} has no outputSchema`);
    expect(ajv.validate(tool.outputSchema, data), JSON.stringify(ajv.errors)).toBe(true);
  }

  it('resolves both same-name actors through the real search/detail handlers', async () => {
    const foundry = connectedClient();
    const pair = duplicatePair(foundry.getWorldData()?.actors ?? [], 'actor');
    const search = await handleSearchActors({ query: pair[0]!.name, limit: 100 }, foundry);
    validate('search_actors', search.structuredContent);
    for (const source of pair) {
      const selected = search.structuredContent.records.find(record => record.id === source._id);
      expect(selected).toBeDefined();
      const detail = await handleGetActorDetails({ actorId: source._id }, foundry);
      validate('get_actor_details', detail.structuredContent);
      expect(detail.structuredContent.record).toEqual(selected);
      expect(detail.structuredContent.record.uuid).toBe(`Actor.${source._id}`);
      expect(search.content[0]?.text).toContain(source._id);
      expect(detail.content[0]?.text).toContain(source._id);
    }
  });

  it('resolves both same-name world items through the real search/detail handlers', async () => {
    const foundry = connectedClient();
    const pair = duplicatePair(foundry.getWorldData()?.items ?? [], 'item');
    const search = await handleSearchItems({ query: pair[0]!.name, limit: 100 }, foundry);
    validate('search_items', search.structuredContent);
    for (const source of pair) {
      const selected = search.structuredContent.records.find(record => record.id === source._id);
      expect(selected).toBeDefined();
      const detail = await handleGetItemDetails({ itemId: source._id }, foundry);
      validate('get_item_details', detail.structuredContent);
      expect(detail.structuredContent.record).toEqual(selected);
      expect(detail.structuredContent.record.uuid).toBe(`Item.${source._id}`);
      expect(search.content[0]?.text).toContain(source._id);
      expect(detail.content[0]?.text).toContain(source._id);
    }
  });

  it('rejects invalid IDs and absent records rather than returning unrelated data', async () => {
    const foundry = connectedClient();
    await expect(handleGetActorDetails({ actorId: '../invalid' }, foundry))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(handleGetItemDetails({ itemId: '../invalid' }, foundry))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    const world = foundry.getWorldData();
    const missingId = ['0000000000000000', '1111111111111111', '2222222222222222'].find(id =>
      !world?.actors.some(record => record._id === id) && !world?.items.some(record => record._id === id));
    if (!missingId) throw new Error('Fixture uses every reserved negative-test ID');
    await expect(handleGetActorDetails({ actorId: missingId }, foundry)).rejects.toThrow();
    await expect(handleGetItemDetails({ itemId: missingId }, foundry)).rejects.toThrow();
  });
});
