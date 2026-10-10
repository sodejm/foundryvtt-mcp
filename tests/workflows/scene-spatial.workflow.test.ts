import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import Ajv from 'ajv';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FoundryMCPServer } from '../../dist/index.js';
import { FoundryClient } from '../../dist/foundry/client.js';
import {
  sceneSpatialOutputSchema, sceneTokenListOutputSchema, sceneTokenOutputSchema,
} from '../../src/foundry/scene-spatial-contract.js';

vi.hoisted(() => {
  process.env.FOUNDRY_URL = 'http://127.0.0.1:30001';
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'error';
});

const gmId = 'U000000000000001';
const aId = 'U000000000000002';
const bId = 'U000000000000003';
const sharedId = 'A000000000000001';
const actorAId = 'A000000000000002';
const actorBId = 'A000000000000003';
const sceneId = (index: number) => `S${String(index).padStart(15, '0')}`;
const tokenId = (index: number) => `T${String(index).padStart(15, '0')}`;
const tools = ['get_scene_spatial', 'list_scene_tokens', 'get_scene_token'];
const gridNames = ['gridless', 'square', 'hex-odd-r', 'hex-even-r', 'hex-odd-q', 'hex-even-q'];

function token(index: number, extra: Record<string, unknown> = {}) {
  return { _id: tokenId(index), name: index < 2 ? 'Duplicate 😀' : `Token ${String(index).padStart(3, '0')}`,
    actorId: sharedId, actorLink: true, x: index ? index * 10 : -100, y: index * 5,
    width: 2, height: 0.5, rotation: 0, elevation: index ? -5 : 0, hidden: false,
    texture: { src: 'icons/svg/mystery-man.svg', scaleX: 2, scaleY: 0.5 },
    flags: { secret: 'NEVER_PUBLIC_TOKEN' }, ...extra };
}
function fixture(count = 251, special = false) {
  const square = { _id: sceneId(1), name: 'Square 😀', active: true, width: 1234, height: 987,
    padding: 0.2, shiftX: 30, shiftY: -25, grid: { type: 1, size: 100, distance: 5, units: 'ft' },
    ownership: { default: 2 } as Record<string, number>, flags: { secret: 'NEVER_PUBLIC_SCENE' },
    tokens: Array.from({ length: count }, (_, index) => token(index)) };
  if (special) square.tokens.push(
    token(900, { name: 'Hidden Shared', hidden: true }),
    token(901, { name: 'Linked A', actorId: actorAId }),
    token(902, { name: 'Linked B', actorId: actorBId }),
    token(903, { name: 'Actorless', actorId: null, actorLink: false }),
    token(904, { name: 'Synthetic A', actorId: actorAId, actorLink: false,
      delta: { name: 'Synthetic A', type: null, ownership: null } }),
    token(905, { name: 'Synthetic Override B', actorId: actorAId, actorLink: false,
      delta: { name: 'Synthetic Override B', type: null, ownership: { default: 0, [bId]: 2 } } }),
    token(906, { name: 'Secret Disposition', actorId: actorAId, disposition: -2 }),
  );
  return { square, world: {
    userId: gmId, release: {}, world: { id: 'scene-workflow', title: 'Fixture' },
    system: { id: 'dnd5e', version: '6.0.6' }, modules: [], demoMode: false,
    scenes: [square, ...[0, 2, 3, 4, 5].map(type => ({ ...structuredClone(square),
      _id: sceneId(type), name: `Grid ${type}`, active: false, padding: type === 0 ? 0 : 0.2,
      grid: { type, size: 100, distance: 5, units: 'ft' }, tokens: [token(0)] })),
    { ...structuredClone(square), _id: sceneId(7), name: 'Empty', active: false, tokens: [] },
    { ...structuredClone(square), _id: sceneId(8), name: 'Secret', active: false, ownership: { default: 0 }, tokens: [token(0)] }],
    actors: [
      { _id: sharedId, name: 'Shared', type: 'npc', ownership: { default: 2 }, flags: { secret: 'NEVER_PUBLIC_ACTOR' } },
      { _id: actorAId, name: 'Actor A', type: 'npc', ownership: { default: 0, [aId]: 2 } },
      { _id: actorBId, name: 'Actor B', type: 'npc', ownership: { default: 0, [bId]: 2 } },
    ],
    users: [{ _id: gmId, name: 'GM', role: 4, color: '#000000' },
      { _id: aId, name: 'A', role: 1, color: '#111111' }, { _id: bId, name: 'B', role: 1, color: '#222222' }],
    items: [], journal: [], messages: [], combats: [], activeUsers: [gmId], settings: [],
    folders: [], macros: [], playlists: [], tables: [], cards: [], packs: [],
  } };
}

// Real built server, client, authorization, schemas and cursor handling. The
// world socket acknowledgement is the only simulated integration boundary.
describe('built MCP scene spatial workflow', () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });
  async function connect(data = fixture(), delegated = false) {
    let principal = aId;
    const backend = new FoundryClient({ baseUrl: 'http://127.0.0.1:30001',
      authorizationMode: delegated ? 'delegated' : 'service-identity' });
    const socket = { connected: true, on: () => socket, off: () => socket,
      emit: (event: string, ...args: unknown[]) => {
        const ack = args.at(-1);
        if (event === 'world' && typeof ack === 'function') queueMicrotask(() => ack(structuredClone(data.world)));
        return socket;
      } };
    Reflect.set(backend, 'socket', socket);
    Reflect.set(backend, 'socketGeneration', 1);
    Reflect.set(backend, 'socketEpoch', 1);
    Reflect.set(backend, 'socketUserId', gmId);
    Reflect.set(backend, '_isConnected', true);
    Reflect.get(backend, 'publishWorldData').call(backend, data.world);
    backend.connect = async () => {};
    backend.disconnect = async () => {};
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    serverTransport.sessionId = 'scene-workflow-session';
    const server = new FoundryMCPServer({ foundryClient: backend,
      ...(delegated && { resolveCaller: (extra: Record<string, unknown>) => ({
        callerId: `workflow:${principal}`, userId: principal, worldId: data.world.world.id,
        sessionId: String(extra.sessionId),
      }) }),
    });
    await server.start(serverTransport);
    const client = new Client({ name: 'scene-spatial-workflow', version: '1' });
    await client.connect(clientTransport);
    closers.push(() => server.shutdown(), () => client.close());
    const schemas = new Map((await client.listTools()).tools.map(tool => [tool.name, tool.outputSchema]));
    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
    async function call(name: string, args: Record<string, unknown> = {}) {
      const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
      expect(ajv.validate(schemas.get(name)!, result.structuredContent), JSON.stringify(ajv.errors)).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(128 * 1024);
      const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
      expect(JSON.parse(text)).toEqual(result.structuredContent);
      expect(text).not.toMatch(/NEVER_PUBLIC|ownership|flags|delta|system|prototypeToken/);
      return result.structuredContent;
    }
    return { client, call, schemas, ...data, use: (userId: string) => { principal = userId; } };
  }
  const list = async (call: Awaited<ReturnType<typeof connect>>['call'], args: Record<string, unknown> = {}) =>
    sceneTokenListOutputSchema.parse(await call('list_scene_tokens', args));

  it.each([0, 1, 100, 101, 251])('traverses %i tokens with stable scene identity, replay and exact IDs', async count => {
    const { call, square } = await connect(fixture(count));
    const first = await list(call, { limit: 100 });
    let page = first;
    const records = [];
    for (;;) {
      expect(page.total).toBe(count);
      expect(page.scene.id).toBe(square._id);
      expect(page.snapshotId).toBe(first.snapshotId);
      expect(page.readMetadata).toMatchObject({ snapshotId: first.readMetadata.snapshotId,
        revision: first.readMetadata.revision, capturedAt: first.readMetadata.capturedAt });
      records.push(...page.records);
      if (!page.nextCursor) break;
      const args = { limit: 100, cursor: page.nextCursor };
      page = await list(call, args);
      expect((await list(call, args)).records).toEqual(page.records);
    }
    expect(records.map(record => record.id)).toEqual(square.tokens.map(record => record._id));
    expect(new Set(records.map(record => record.id)).size).toBe(count);
    expect(page).toMatchObject({ complete: true, nextCursor: null });
  });

  it.each([0, 1, 2, 3, 4, 5])('reports native grid %i dimensions and explicit units', async type => {
    const { call } = await connect(fixture(1));
    const result = sceneSpatialOutputSchema.parse(await call('get_scene_spatial', { sceneId: sceneId(type) }));
    const expected = type === 0 ? [1234, 987, -30, 25, 987, 1234]
      : type === 1 ? [1834, 1387, 270, 225, 14, 19]
      : type < 4 ? [1900, 1501.110699893027, 320, 284.8076211353316, 17, 20]
      : [1760.9183210283588, 1500, 229.8076211353316, 275, 16, 20];
    const d = result.scene.dimensions;
    [d.widthPixels, d.heightPixels, d.originXPixels, d.originYPixels, d.rows, d.columns]
      .forEach((value, index) => expect(value).toBeCloseTo(expected[index]!, 8));
    expect(result.scene.grid).toEqual({ type: gridNames[type], sizePixels: 100, distance: 5, distanceUnits: 'ft' });
    expect(result.scene.units).toEqual({ coordinates: 'pixels', dimensions: 'pixels', padding: 'ratio', gridSize: 'pixels', gridDistance: 'scene-distance' });
    expect(result.scene.dimensions.derivation).toBe('foundry-native');
  });

  it('keeps gridless padding and distinguishes absent optional distances and elevation from zero', async () => {
    const data = fixture(1);
    const gridless = data.world.scenes.find(scene => scene.grid.type === 0)!;
    gridless.padding = 0.2;
    delete (gridless.grid as { distance?: number }).distance;
    delete (gridless.grid as { units?: string }).units;
    delete (gridless.tokens[0] as { elevation?: number }).elevation;
    const { call } = await connect(data);
    const spatial = sceneSpatialOutputSchema.parse(await call('get_scene_spatial', { sceneId: gridless._id }));
    expect(spatial.scene.dimensions).toMatchObject({ widthPixels: 1834, heightPixels: 1387, originXPixels: 270, originYPixels: 225, rows: 1387, columns: 1834 });
    expect(spatial.scene.grid).not.toHaveProperty('distance');
    expect(spatial.scene.grid).not.toHaveProperty('distanceUnits');
    const absent = sceneTokenOutputSchema.parse(await call('get_scene_token', { sceneId: gridless._id, tokenId: tokenId(0) }));
    expect(absent.token).not.toHaveProperty('elevation');
    expect(absent.token).not.toHaveProperty('elevationUnits');
    const zero = sceneTokenOutputSchema.parse(await call('get_scene_token', { tokenId: tokenId(0) }));
    expect(zero.token).toMatchObject({ xPixels: -100, yPixels: 0, widthGridSpaces: 2, heightGridSpaces: 0.5,
      rotationDegrees: 0, elevation: 0, elevationUnits: 'scene-distance', texture: { scaleX: 2, scaleY: 0.5 },
      actor: { id: sharedId, uuid: `Actor.${sharedId}`, linked: true } });
    expect(zero.token.units).toEqual({ position: 'pixels', footprint: 'grid-spaces', rotation: 'degrees', elevation: 'scene-distance' });
  });

  it('rejects malformed protocol inputs, missing parent/detail and cursor scope changes', async () => {
    const { client, call } = await connect();
    for (const name of tools) {
      const detail = name === 'get_scene_token' ? { tokenId: tokenId(0) } : {};
      for (const sceneId of ['bad', 'Scene.AAAAAAAAAAAAAAAA']) await expect(client.callTool({ name, arguments: { ...detail, sceneId } }))
        .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
      await expect(client.callTool({ name, arguments: { ...detail, sceneId: 'AAAAAAAAAAAAAAAA' } }))
        .rejects.toMatchObject({ code: ErrorCode.InternalError });
      await expect(client.callTool({ name, arguments: { ...detail, userId: gmId } }))
        .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    }
    for (const tokenId of ['bad', 'Token.AAAAAAAAAAAAAAAA']) await expect(client.callTool({ name: 'get_scene_token', arguments: { tokenId } }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(client.callTool({ name: 'get_scene_token', arguments: { tokenId: 'AAAAAAAAAAAAAAAA' } }))
      .rejects.toMatchObject({ code: ErrorCode.InternalError });
    for (const args of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { query: 'x'.repeat(1025) }, { cursor: '' }])
      await expect(client.callTool({ name: 'list_scene_tokens', arguments: args })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    const first = await list(call, { limit: 1 });
    for (const args of [{ cursor: 'corrupt' }, { cursor: first.nextCursor, sceneId: sceneId(7) },
      { cursor: first.nextCursor, query: 'Token' }, { cursor: first.nextCursor, limit: 2 }])
      await expect(client.callTool({ name: 'list_scene_tokens', arguments: { limit: 1, ...args } })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    expect(await list(call, { query: 'DUPLICATE' })).toMatchObject({ total: 2 });
    expect(await list(call, { query: 'not found' })).toMatchObject({ total: 0, complete: true, nextCursor: null });
    expect(await list(call, { sceneId: sceneId(7) })).toMatchObject({ total: 0, complete: true });
  });

  it('filters permissions before counts, lookup and cursors and merges synthetic actor ownership', async () => {
    const { call, client, use } = await connect(fixture(251, true), true);
    for (const [user, total, visibleSpecial] of [[aId, 256, [901, 903, 904, 905, 906]], [bId, 254, [902, 903, 905]]] as const) {
      use(user);
      const first = await list(call, { limit: 100 });
      expect(first.total).toBe(total);
      const ids = first.records.map(record => record.id);
      let page = first;
      while (page.nextCursor) { page = await list(call, { limit: 100, cursor: page.nextCursor }); ids.push(...page.records.map(record => record.id)); }
      expect(new Set(ids)).toEqual(new Set([...Array.from({ length: 251 }, (_, index) => tokenId(index)), ...visibleSpecial.map(tokenId)]));
      const errors = [];
      for (const hiddenId of [tokenId(900), tokenId(user === aId ? 902 : 901), 'AAAAAAAAAAAAAAAA']) {
        const error = await client.callTool({ name: 'get_scene_token', arguments: { tokenId: hiddenId } }).catch(error => error);
        expect(error).toMatchObject({ code: ErrorCode.InternalError });
        expect(error.message).toMatch(/Delegated read unavailable/);
        errors.push(error.message);
      }
      expect(new Set(errors).size).toBe(1);
      for (const name of tools) await expect(client.callTool({ name, arguments: { sceneId: sceneId(8), ...(name === 'get_scene_token' && { tokenId: tokenId(0) }) } }))
        .rejects.toMatchObject({ code: ErrorCode.InternalError });
    }
    use(aId);
    const first = await list(call, { limit: 1 });
    use(bId);
    await expect(client.callTool({ name: 'list_scene_tokens', arguments: { limit: 1, cursor: first.nextCursor } }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it('invalidates snapshots on token, scene, active selection and permission changes', async () => {
    const data = fixture(3, true);
    const { call, client, use } = await connect(data, true);
    for (const mutate of [() => { data.square.tokens[0]!.x += 17; },
      () => { data.square.tokens[1]!.hidden = true; }, () => { data.square.width += 100; },
      () => { data.world.scenes[1]!.active = true; data.square.active = false; }]) {
      const first = await list(call, { limit: 1 });
      mutate();
      await expect(client.callTool({ name: 'list_scene_tokens', arguments: { limit: 1, cursor: first.nextCursor } }))
        .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    }
    expect(sceneSpatialOutputSchema.parse(await call('get_scene_spatial')).scene.id).toBe(sceneId(0));
    data.square.active = true; data.world.scenes[1]!.active = false;
    const permission = await list(call, { limit: 1 });
    data.world.actors[0]!.ownership[aId] = 0;
    await expect(client.callTool({ name: 'list_scene_tokens', arguments: { limit: 1, cursor: permission.nextCursor } }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    expect((await list(call)).total).toBe(5);
    data.square.ownership[aId] = 0;
    for (const name of tools) await expect(client.callTool({ name, arguments: { sceneId: data.square._id, ...(name === 'get_scene_token' && { tokenId: tokenId(903) }) } }))
      .rejects.toMatchObject({ code: ErrorCode.InternalError });
    use(gmId);
    expect((await list(call)).total).toBe(10);
  });
});
