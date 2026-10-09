import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import Ajv from 'ajv';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FoundryMCPServer } from '../../dist/index.js';
import { FoundryClient } from '../../dist/foundry/client.js';
import {
  ACTOR_SECTION_NAMES, actorItemListOutputSchema, actorItemOutputSchema,
  actorSectionOutputSchema, actorSheetOutputSchema,
} from '../../src/foundry/actor-sheet-contract.js';

vi.hoisted(() => {
  process.env.FOUNDRY_URL = 'http://127.0.0.1:30001';
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'error';
});

const actorId = 'A000000000000001';
const otherId = 'A000000000000002';
const gmId = 'U000000000000001';
const playerId = 'U000000000000002';
const systemVersions: Record<string, string> = { dnd5e: '6.0.6', pf2e: '6.2.0' };
const itemId = (index: number) => `I${String(index).padStart(15, '0')}`;
const toolInputs = [
  ['get_actor_sheet', {}], ['get_actor_section', { section: 'attributes' }],
  ['list_actor_items', {}], ['get_actor_item', { itemId: itemId(0) }],
] as const;

function fixture(count = 251, systemId = 'dnd5e') {
  const actor = {
    _id: actorId, name: 'Actor 😀', type: 'npc',
    ownership: { default: 0, [playerId]: 2 }, flags: { secret: 'NEVER_PUBLIC' },
    system: {
      attributes: { hp: { value: 0, max: 23 }, ac: { value: 12 } },
      details: { level: systemId === 'pf2e' ? { value: 0 } : 0,
        biography: { value: '<p>Public biography</p><section class="secret">NEVER_PUBLIC</section>' } },
      currency: { gp: 0 },
    },
    items: Array.from({ length: count }, (_, index) => ({
      _id: itemId(index), name: index < 2 ? 'Duplicate 😀' : `Gear ${String(index).padStart(3, '0')}`,
      type: 'loot', sort: index * 1000, ownership: { default: -1 }, flags: { secret: 'NEVER_PUBLIC' },
      system: { quantity: index, equipped: false,
        description: { value: '<p>Public description</p><section class="secret">NEVER_PUBLIC</section>' } },
    })),
  };
  return {
    actor,
    world: {
      userId: gmId, release: {}, world: { id: 'actor-workflow', title: 'Fixture' },
      system: { id: systemId, version: systemVersions[systemId] ?? 'fixture-version' }, modules: [], demoMode: false,
      actors: [actor, { ...structuredClone(actor), _id: otherId, name: 'Hidden actor',
        ownership: { default: 0, [playerId]: 0 }, items: [{ ...structuredClone(actor.items[0] ?? {
          _id: itemId(0), name: 'Other item', type: 'loot', system: {}, ownership: { default: -1 },
        }), _id: itemId(999) }] }],
      items: [], scenes: [], journal: [], messages: [], combats: [], activeUsers: [gmId],
      users: [{ _id: gmId, name: 'GM', role: 4, color: '#000000' },
        { _id: playerId, name: 'Player', role: 1, color: '#111111' }],
      settings: [], folders: [], macros: [], playlists: [], tables: [], cards: [], packs: [],
    },
  };
}

// Real built client, profiles, permission projector and server. Only the Foundry
// socket snapshot exchange is simulated; live compatibility is tested separately.
describe('built MCP actor sheet workflow', () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
  });
  async function connect(data = fixture(), delegated = false) {
    const backend = new FoundryClient({ baseUrl: 'http://127.0.0.1:30001',
      authorizationMode: delegated ? 'delegated' : 'service-identity' });
    const socket = {
      connected: true,
      on: () => socket, off: () => socket,
      emit: (event: string, ...args: unknown[]) => {
        const ack = args.at(-1);
        if (event === 'world' && typeof ack === 'function') queueMicrotask(() => ack(structuredClone(data.world)));
        return socket;
      },
      disconnect: () => { socket.connected = false; return socket; },
    };
    Reflect.set(backend, 'socket', socket);
    Reflect.set(backend, 'socketGeneration', 1);
    Reflect.set(backend, 'socketEpoch', 1);
    Reflect.set(backend, 'socketUserId', gmId);
    Reflect.set(backend, '_isConnected', true);
    Reflect.get(backend, 'publishWorldData').call(backend, data.world);
    backend.connect = async () => {};
    backend.disconnect = async () => {};
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    serverTransport.sessionId = 'actor-workflow-mcp-session';
    const server = new FoundryMCPServer({ foundryClient: backend,
      ...(delegated && { resolveCaller: (extra: Record<string, unknown>) => ({
        callerId: 'trusted-workflow-principal', userId: playerId,
        worldId: data.world.world.id, sessionId: String(extra.sessionId),
      }) }),
    });
    await server.start(serverTransport);
    const client = new Client({ name: 'actor-sheet-workflow', version: '1' });
    await client.connect(clientTransport);
    closers.push(() => server.shutdown(), () => client.close());
    const schemas = new Map((await client.listTools()).tools.map(tool => [tool.name, tool.outputSchema]));
    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
    async function call(name: string, args: Record<string, unknown>) {
      const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: { actorId, ...args } }));
      expect(ajv.validate(schemas.get(name)!, result.structuredContent), JSON.stringify(ajv.errors)).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(128 * 1024);
      const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
      expect(JSON.parse(text)).toEqual(result.structuredContent);
      expect(text).not.toMatch(/NEVER_PUBLIC|ownership|flags|prototypeToken/);
      return result.structuredContent;
    }
    return { client, call, schemas, ...data };
  }

  it.each(['dnd5e', 'pf2e'])('composes the %s descriptor, sections and item detail', async system => {
    const { call } = await connect(fixture(2, system));
    const sheet = actorSheetOutputSchema.parse(await call('get_actor_sheet', {}));
    expect(sheet).toMatchObject({ itemCount: 2, system: { id: system, version: systemVersions[system], profile: system } });
    expect(sheet.sections.map(section => section.name)).toEqual(ACTOR_SECTION_NAMES);
    for (const section of sheet.sections) {
      const result = actorSectionOutputSchema.parse(await call('get_actor_section', { section: section.name }));
      expect(result).toMatchObject({ supported: section.supported });
      expect(result.fields).toHaveLength(section.fieldCount);
      if (section.name === 'attributes') expect(result.fields.find(field => field.key === 'hp.value'))
        .toMatchObject({ present: true, value: 0 });
      if (section.name === 'details') expect(result.fields.find(field => field.key === 'level'))
        .toMatchObject({ present: true, value: 0,
          path: system === 'pf2e' ? 'system.details.level.value' : 'system.details.level' });
    }
    const list = actorItemListOutputSchema.parse(await call('list_actor_items', {}));
    expect(list.records).toHaveLength(2);
    for (const record of list.records) {
      const result = actorItemOutputSchema.parse(await call('get_actor_item', { itemId: record.id }));
      expect(result.item).toMatchObject({ id: record.id, parentActorId: actorId,
        uuid: `Actor.${actorId}.Item.${record.id}` });
    }
  });

  it.each([0, 1, 100, 101, 251])('traverses %i items exactly once with stable metadata and replay', async count => {
    const { call, actor } = await connect(fixture(count));
    const records = [];
    let page = actorItemListOutputSchema.parse(await call('list_actor_items', { limit: 100 }));
    const first = page;
    for (;;) {
      expect(page.total).toBe(count);
      expect(page.snapshotId).toBe(first.snapshotId);
      expect(page.readMetadata).toMatchObject({ snapshotId: first.readMetadata.snapshotId,
        revision: first.readMetadata.revision, capturedAt: first.readMetadata.capturedAt });
      records.push(...page.records);
      if (!page.nextCursor) break;
      const args = { limit: 100, cursor: page.nextCursor };
      page = actorItemListOutputSchema.parse(await call('list_actor_items', args));
      expect(actorItemListOutputSchema.parse(await call('list_actor_items', args)).records).toEqual(page.records);
    }
    expect(records.map(record => record.id)).toEqual(actor.items.map(item => item._id));
    expect(new Set(records.map(record => record.id)).size).toBe(count);
    expect(page).toMatchObject({ complete: true, nextCursor: null });
  });

  it('bounds generic paths and values while explicitly marking unsupported sections', async () => {
    const data = fixture(1, 'custom-system');
    data.actor.system = Object.fromEntries(Array.from({ length: 100 }, (_, index) =>
      [`field${index}`, '😀'.repeat(20_000)])) as typeof data.actor.system;
    Object.assign(data.actor.system, { credentials: { password: 'NEVER_PUBLIC' }, flags: 'NEVER_PUBLIC' });
    const { call } = await connect(data);
    const sheet = actorSheetOutputSchema.parse(await call('get_actor_sheet', {}));
    expect(sheet.system.profile).toBe('generic');
    expect(sheet.sections.filter(section => section.supported).map(section => section.name)).toEqual(['system']);
    const section = actorSectionOutputSchema.parse(await call('get_actor_section', { section: 'system' }));
    expect(section.fields.length).toBeLessThanOrEqual(64);
    expect(section.fields.every(field => field.source === 'system-path')).toBe(true);
    expect(section.fields.some(field => field.truncated)).toBe(true);
    expect(section.fields.filter(field => typeof field.value === 'string')
      .every(field => (field.value as string).isWellFormed())).toBe(true);
    expect(actorSectionOutputSchema.parse(await call('get_actor_section', { section: 'attributes' })))
      .toMatchObject({ supported: false, fields: [] });
  });

  it('rejects malformed inputs, missing parents and cursor scope mismatches at the protocol boundary', async () => {
    const { client, call } = await connect();
    for (const [name, extra] of toolInputs) {
      await expect(client.callTool({ name, arguments: { actorId: 'bad', ...extra } }))
        .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
      await expect(client.callTool({ name, arguments: { actorId: 'Z000000000000001', ...extra } }))
        .rejects.toMatchObject({ code: ErrorCode.InternalError });
      await expect(client.callTool({ name, arguments: { actorId, ...extra, userId: gmId } }))
        .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    }
    await expect(client.callTool({ name: 'get_actor_item', arguments: { actorId, itemId: itemId(999) } }))
      .rejects.toMatchObject({ code: ErrorCode.InternalError });
    const page = actorItemListOutputSchema.parse(await call('list_actor_items', { limit: 1 }));
    for (const extra of [{ cursor: 'corrupt' }, { cursor: page.nextCursor, actorId: otherId },
      { cursor: page.nextCursor, query: 'Gear' }, { cursor: page.nextCursor, type: 'loot' },
      { cursor: page.nextCursor, limit: 2 }]) {
      await expect(client.callTool({ name: 'list_actor_items', arguments: { actorId, limit: 1, ...extra } }))
        .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    }
  });

  it('projects delegated actor/item permissions and invalidates a cursor after embedded visibility changes', async () => {
    const data = fixture(3);
    data.actor.items[2]!.ownership.default = 0;
    const { client, call } = await connect(data, true);
    const sheet = actorSheetOutputSchema.parse(await call('get_actor_sheet', {}));
    expect(sheet.itemCount).toBe(2);
    const details = actorSectionOutputSchema.parse(await call('get_actor_section', { section: 'details' }));
    expect(details.fields.some(field => field.key === 'biography')).toBe(false);
    const item = actorItemOutputSchema.parse(await call('get_actor_item', { itemId: itemId(0) }));
    expect(item.item.fields.some(field => field.key === 'description')).toBe(false);
    const first = actorItemListOutputSchema.parse(await call('list_actor_items', { limit: 1 }));
    const deniedErrors = [];
    for (const hiddenId of [otherId, 'Z000000000000001']) {
      const error = await client.callTool({ name: 'get_actor_sheet', arguments: { actorId: hiddenId } })
        .catch(error => error);
      expect(error).toMatchObject({ code: ErrorCode.InternalError });
      expect(error.message).toMatch(/Delegated read unavailable/);
      deniedErrors.push(error.message);
    }
    expect(deniedErrors[0]).toBe(deniedErrors[1]);
    await expect(client.callTool({ name: 'get_actor_item', arguments: { actorId, itemId: itemId(2) } }))
      .rejects.toMatchObject({ code: ErrorCode.InternalError });
    data.actor.items[1]!.ownership.default = 0;
    await expect(client.callTool({ name: 'list_actor_items', arguments: { actorId, limit: 1, cursor: first.nextCursor } }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    expect(actorItemListOutputSchema.parse(await call('list_actor_items', {})).total).toBe(1);
    data.actor.ownership[playerId] = 0;
    for (const [name, extra] of toolInputs) await expect(client.callTool({ name, arguments: { actorId, ...extra } }))
      .rejects.toMatchObject({ code: ErrorCode.InternalError });
  });

  it('fails generic system reads closed for delegated callers', async () => {
    const { client } = await connect(fixture(1, 'custom-system'), true);
    for (const [name, extra] of toolInputs) await expect(client.callTool({ name, arguments: { actorId, ...extra } }))
      .rejects.toMatchObject({ code: ErrorCode.InternalError });
  });
});
