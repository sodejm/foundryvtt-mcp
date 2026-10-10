/** Native Foundry geometry and permission oracles through the built MCP boundary. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import Ajv from 'ajv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FoundryMCPServer } from '../../dist/index.js';
import { FoundryClient as BuiltFoundryClient } from '../../dist/foundry/client.js';
import {
  sceneSpatialOutputSchema, sceneTokenListOutputSchema, sceneTokenOutputSchema,
  type SceneTokenSummary,
} from '../../src/foundry/scene-spatial-contract.js';
import { worldReadMetadataSchema } from '../../src/foundry/freshness.js';

const oracleSchema = z.object({
  gmId: z.string(), activeSceneId: z.string().nullable(),
  users: z.array(z.object({ id: z.string(), name: z.string(), role: z.number() })),
  scenes: z.array(z.object({
    id: z.string(), name: z.string(), width: z.number(), height: z.number(), padding: z.number(),
    shiftX: z.number(), shiftY: z.number(),
    grid: z.object({ type: z.number(), size: z.number(), distance: z.number(), units: z.string() }),
    dimensions: z.object({ width: z.number(), height: z.number(), sceneX: z.number(), sceneY: z.number(), rows: z.number(), columns: z.number() }),
    tokens: z.array(z.object({ id: z.string(), name: z.string(), actorId: z.string().nullable(),
      actorLink: z.boolean(), x: z.number(), y: z.number(), width: z.number(), height: z.number(),
      rotation: z.number(), elevation: z.number(), hidden: z.boolean(), disposition: z.number(),
      scaleX: z.number(), scaleY: z.number(),
    })),
    permissions: z.array(z.object({ userId: z.string(), sceneVisible: z.boolean(), tokenIds: z.array(z.string()),
      actors: z.array(z.object({ tokenId: z.string(), visible: z.boolean(), level: z.number(), synthetic: z.boolean() })),
    })),
  })),
});
type Oracle = z.infer<typeof oracleSchema>;
type Scene = Oracle['scenes'][number];
const gridNames = ['gridless', 'square', 'hex-odd-r', 'hex-even-r', 'hex-odd-q', 'hex-even-q'];
const toolNames = ['get_scene_spatial', 'list_scene_tokens', 'get_scene_token'];

describe('live scene spatial reads through built MCP', () => {
  let controlUrl = '';
  let cwd = '';
  let seed: Oracle;
  let square: Scene;
  let client: Client;
  let other: Client;
  let delegated: Client;
  let principal = '';
  let a = '';
  let b = '';
  const clients: Client[] = [];
  const transports: StdioClientTransport[] = [];
  const servers: FoundryMCPServer[] = [];
  const schemas = new Map<string, object>();
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
  async function control(path: string, method = 'POST') {
    const response = await fetch(controlUrl + path, { method, signal: AbortSignal.timeout(90_000) });
    if (!response.ok) throw new Error(`Scene fixture controller failed (${response.status})`);
    return response.json();
  }
  async function oracle() { return oracleSchema.parse(await control('/oracle', 'GET')); }
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
    const connected = new Client({ name: 'live-scene-spatial-stdio', version: '1' });
    clients.push(connected);
    await connected.connect(transport);
    for (const tool of (await connected.listTools()).tools) if (tool.outputSchema) schemas.set(tool.name, tool.outputSchema);
    return connected;
  }
  async function connectDelegated() {
    const backend = new BuiltFoundryClient({ baseUrl: process.env.FOUNDRY_URL!,
      username: process.env.FOUNDRY_USERNAME!, password: process.env.FOUNDRY_PASSWORD ?? '',
      authorizationMode: 'delegated', timeout: 15_000,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    serverTransport.sessionId = 'live-scene-session';
    const send = clientTransport.send.bind(clientTransport);
    clientTransport.send = (message, options) => send(message, {
      ...options, authInfo: { token: 'live-scene-caller', clientId: 'live-scene-host', scopes: ['foundry:read'] },
    });
    const server = new FoundryMCPServer({ foundryClient: backend, resolveCaller: metadata =>
      metadata.authInfo?.token === 'live-scene-caller' ? { callerId: `live:${principal}`,
        userId: principal, worldId: 'test1world', sessionId: 'live-scene-session' } : undefined,
    });
    servers.push(server);
    await server.start(serverTransport);
    const connected = new Client({ name: 'live-scene-spatial-delegated', version: '1' });
    clients.push(connected);
    await connected.connect(clientTransport);
    return connected;
  }
  beforeAll(async () => {
    controlUrl = process.env.FOUNDRY_SCENE_TEST_CONTROL_URL ?? '';
    if (!controlUrl || !process.env.FOUNDRY_URL || !process.env.FOUNDRY_USERNAME) {
      throw new Error('Live scene tests require the disposable-world controller and Foundry credentials');
    }
    const status = z.object({ world: z.literal('test1world'), version: z.string(), system: z.literal('dnd5e'), systemVersion: z.string() })
      .parse(await control('/status', 'GET'));
    console.info('Live scene integration versions', JSON.stringify(status));
    seed = oracleSchema.parse(await control('/seed'));
    square = seed.scenes.find(scene => scene.name.endsWith('Grid 1'))!;
    a = seed.users.find(user => user.name.endsWith('Player A'))!.id;
    b = seed.users.find(user => user.name.endsWith('Player B'))!.id;
    principal = a;
    cwd = await mkdtemp(join(tmpdir(), 'foundry-live-scenes-'));
    client = await connect();
    other = await connect();
    delegated = await connectDelegated();
  });
  afterAll(async () => {
    await Promise.allSettled([...clients.map(c => c.close()), ...transports.map(t => t.close()), ...servers.map(s => s.shutdown())]);
    try { if (controlUrl) await control('/cleanup'); }
    finally { if (cwd) await rm(cwd, { recursive: true, force: true }); }
  });
  async function call(name: string, args: Record<string, unknown> = {}, connected = client) {
    const result = CallToolResultSchema.parse(await connected.callTool({ name, arguments: args }));
    expect(ajv.validate(schemas.get(name)!, result.structuredContent), JSON.stringify(ajv.errors)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(128 * 1024);
    const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
    expect(JSON.parse(text)).toEqual(result.structuredContent);
    expect(text).not.toMatch(/NEVER_PUBLIC|ownership|flags|delta|prototypeToken/);
    const { readMetadata } = z.object({ readMetadata: worldReadMetadataSchema }).parse(result.structuredContent);
    expect(readMetadata.freshness).not.toBe('unavailable');
    if (args.cursor === undefined) expect(readMetadata.freshness).toBe('current');
    return result.structuredContent;
  }
  async function list(args: Record<string, unknown> = {}, connected = client) {
    return sceneTokenListOutputSchema.parse(await call('list_scene_tokens', { sceneId: square.id, ...args }, connected));
  }
  async function token(id: string, connected = client) {
    return sceneTokenOutputSchema.parse(await call('get_scene_token', { sceneId: square.id, tokenId: id }, connected));
  }
  async function allTokens(scene: Scene, limit = 100, connected = client) {
    const first = await list({ sceneId: scene.id, limit }, connected);
    const records = [...first.records];
    let page = first;
    while (page.nextCursor) {
      page = await list({ sceneId: scene.id, limit, cursor: page.nextCursor }, connected);
      expect(page.snapshotId).toBe(first.snapshotId);
      expect(page.readMetadata).toMatchObject({ snapshotId: first.readMetadata.snapshotId,
        revision: first.readMetadata.revision, capturedAt: first.readMetadata.capturedAt });
      expect(page.total).toBe(first.total);
      records.push(...page.records);
    }
    expect(page).toMatchObject({ complete: true, nextCursor: null });
    expect(new Set(records.map(record => record.id)).size).toBe(first.total);
    return records;
  }
  function compareTokens(records: SceneTokenSummary[], scene: Scene, userId: string) {
    const permission = scene.permissions.find(entry => entry.userId === userId)!;
    const expected = scene.tokens.filter(entry => permission.tokenIds.includes(entry.id))
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }) || left.id.localeCompare(right.id));
    expect(records.map(record => record.id)).toEqual(expected.map(record => record.id));
    for (const record of records) {
      const native = expected.find(entry => entry.id === record.id)!;
      expect(record).toMatchObject({ id: native.id, uuid: `Scene.${scene.id}.Token.${native.id}`,
        sceneId: scene.id, sceneUuid: `Scene.${scene.id}`, name: native.name,
        xPixels: native.x, yPixels: native.y, widthGridSpaces: native.width, heightGridSpaces: native.height,
        rotationDegrees: native.rotation, elevation: native.elevation, elevationUnits: 'scene-distance', hidden: native.hidden,
        units: { position: 'pixels', footprint: 'grid-spaces', rotation: 'degrees', elevation: 'scene-distance' },
      });
      expect(record).not.toHaveProperty('texture');
      const actorVisible = permission.actors.find(entry => entry.tokenId === native.id)!.visible;
      if (actorVisible) expect(record.actor).toMatchObject({ id: native.actorId, uuid: `Actor.${native.actorId}`, linked: native.actorLink });
      else expect(record).not.toHaveProperty('actor');
    }
  }
  async function mutate(kind: string, sceneId = square.id, tokenId?: string, userId?: string) {
    const params = new URLSearchParams({ kind, sceneId, ...(tokenId && { tokenId }), ...(userId && { userId }) });
    await control(`/mutate?${params}`);
  }
  async function invalidated(args: Record<string, unknown>, connected = client) {
    await expect.poll(async () => {
      try { await connected.callTool({ name: 'list_scene_tokens', arguments: args }); return false; }
      catch (error) { return (error as { code: number }).code === ErrorCode.InvalidParams; }
    }, { timeout: 15_000 }).toBe(true);
  }

  it('matches native dimensions for all grids, zero-padding hex and padded gridless scenes', async () => {
    expect(seed.scenes).toHaveLength(13);
    for (const fixture of seed.scenes) {
      const result = sceneSpatialOutputSchema.parse(await call('get_scene_spatial', { sceneId: fixture.id }));
      expect(result.scene).toMatchObject({ id: fixture.id, uuid: `Scene.${fixture.id}`, name: fixture.name,
        active: fixture.id === seed.activeSceneId,
        source: { widthPixels: fixture.width, heightPixels: fixture.height, paddingRatio: fixture.padding,
          shiftXPixels: fixture.shiftX, shiftYPixels: fixture.shiftY },
        grid: { type: gridNames[fixture.grid.type], sizePixels: fixture.grid.size,
          distance: fixture.grid.distance, distanceUnits: fixture.grid.units },
        units: { coordinates: 'pixels', dimensions: 'pixels', padding: 'ratio', gridSize: 'pixels', gridDistance: 'scene-distance' },
      });
      const dimensions = result.scene.dimensions;
      for (const [key, value] of Object.entries({ widthPixels: fixture.dimensions.width, heightPixels: fixture.dimensions.height,
        originXPixels: fixture.dimensions.sceneX, originYPixels: fixture.dimensions.sceneY })) {
        expect(dimensions[key as keyof typeof dimensions]).toBeCloseTo(value, 8);
      }
      expect(dimensions).toMatchObject({ rows: fixture.dimensions.rows, columns: fixture.dimensions.columns, derivation: 'foundry-native' });
    }
  });
  it.each([10, 100])('traverses 258 native tokens at limit %i with exact positions and actor references', async limit => {
    const records = await allTokens(square, limit);
    expect(records).toHaveLength(258);
    compareTokens(records, square, seed.gmId);
    expect(records.filter(record => record.name === 'Duplicate 😀')).toHaveLength(2);
    expect(records.some(record => record.xPixels < 0 && record.elevation === 0)).toBe(true);
  });
  it('matches token detail and footprint independently of art scaling on every grid', async () => {
    for (const scene of seed.scenes.filter(entry => entry.tokens.length)) {
      const records = await allTokens(scene);
      compareTokens(records, scene, seed.gmId);
      const fixture = scene.tokens[0]!;
      const detail = sceneTokenOutputSchema.parse(await call('get_scene_token', { sceneId: scene.id, tokenId: fixture.id }));
      const { texture, ...summary } = detail.token;
      expect(summary).toEqual(records.find(record => record.id === fixture.id));
      expect(texture).toMatchObject({ scaleX: fixture.scaleX, scaleY: fixture.scaleY });
      expect(detail.token.widthGridSpaces).toBe(2);
      expect(detail.token.heightGridSpaces).toBe(0.5);
    }
  });
  it('supports one-record pages, replay, Unicode filters and empty scenes', async () => {
    const first = await list({ limit: 1 });
    expect(first).toMatchObject({ total: 258, returnedCount: 1, complete: false });
    const args = { limit: 1, cursor: first.nextCursor };
    expect((await list(args)).records).toEqual((await list(args)).records);
    expect(await list({ query: 'DUPLICATE 😀' })).toMatchObject({ total: 2 });
    expect(await list({ query: 'no matching fixture' })).toMatchObject({ total: 0, records: [], complete: true, nextCursor: null });
    const empty = seed.scenes.find(scene => scene.name.endsWith('Empty'))!;
    expect(await list({ sceneId: empty.id })).toMatchObject({ total: 0, records: [], complete: true, nextCursor: null });
  });
  it('keeps legacy scene summaries and service resources compatible', async () => {
    const summary = await client.callTool({ name: 'get_scene_info', arguments: { sceneId: square.id } });
    expect(summary.content.some(block => block.type === 'text' && block.text.includes(square.name) && block.text.includes('1234 x 987 pixels'))).toBe(true);
    const current = await client.readResource({ uri: 'foundry://scenes/current' });
    expect(JSON.parse((current.contents[0] as { text: string }).text).currentScene._id).toBe(square.id);
    const collection = await client.readResource({ uri: 'foundry://scenes' });
    expect(JSON.parse((collection.contents[0] as { text: string }).text)).toMatchObject({ schemaVersion: 3, collection: 'scenes' });
    await expect(delegated.readResource({ uri: 'foundry://scenes/current' })).rejects.toMatchObject({ code: ErrorCode.InvalidRequest });
  });
  it.each(toolNames)('%s rejects malformed IDs, unknown fields and missing scenes', async name => {
    const extra = name === 'get_scene_token' ? { tokenId: square.tokens[0]!.id } : {};
    for (const sceneId of ['bad', `Scene.${square.id}`, '']) {
      await expect(client.callTool({ name, arguments: { ...extra, sceneId } })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    }
    await expect(client.callTool({ name, arguments: { ...extra, sceneId: square.id, unexpected: true } })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(client.callTool({ name, arguments: { ...extra, sceneId: 'AAAAAAAAAAAAAAAA' } })).rejects.toMatchObject({ code: ErrorCode.InternalError });
  });
  it('rejects invalid token IDs, wrong parents, limits and filters', async () => {
    for (const tokenId of ['bad', `Token.${square.tokens[0]!.id}`, '']) {
      await expect(client.callTool({ name: 'get_scene_token', arguments: { sceneId: square.id, tokenId } })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    }
    const otherScene = seed.scenes.find(scene => scene.grid.type === 0 && scene.tokens.length)!;
    for (const args of [{ sceneId: square.id, tokenId: otherScene.tokens[0]!.id }, { sceneId: otherScene.id, tokenId: square.tokens[0]!.id }, { sceneId: square.id, tokenId: 'AAAAAAAAAAAAAAAA' }]) {
      await expect(client.callTool({ name: 'get_scene_token', arguments: args })).rejects.toMatchObject({ code: ErrorCode.InternalError });
    }
    for (const args of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { query: 'x'.repeat(1025) }, { cursor: '' }, { cursor: 'x'.repeat(1025) }]) {
      await expect(client.callTool({ name: 'list_scene_tokens', arguments: { sceneId: square.id, ...args } })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    }
  });
  it('binds cursors to scene, query, limit, session and integrity', async () => {
    const first = await list({ limit: 1 });
    const cursor = first.nextCursor!;
    for (const [connected, args] of [
      [client, { sceneId: seed.scenes.find(scene => scene.id !== square.id)!.id, limit: 1, cursor }],
      [client, { sceneId: square.id, limit: 2, cursor }],
      [client, { sceneId: square.id, limit: 1, query: 'Duplicate', cursor }],
      [other, { sceneId: square.id, limit: 1, cursor }],
      [client, { sceneId: square.id, limit: 1, cursor: cursor.slice(0, -2) + 'xx' }],
    ] as const) {
      await expect(connected.callTool({ name: 'list_scene_tokens', arguments: args })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    }
    expect((await list({ limit: 1, cursor })).page).toBe(2);
  });
  it('matches native GM and two-player visibility before counts, pages, lookups and actor references', async () => {
    for (const userId of [seed.gmId, a, b]) {
      principal = userId;
      const records = await allTokens(square, 100, delegated);
      compareTokens(records, square, userId);
      const permission = square.permissions.find(entry => entry.userId === userId)!;
      for (const fixture of square.tokens.filter(entry => !permission.tokenIds.includes(entry.id))) {
        await expect(delegated.callTool({ name: 'get_scene_token', arguments: { sceneId: square.id, tokenId: fixture.id } }))
          .rejects.toMatchObject({ code: ErrorCode.InternalError, message: expect.stringContaining('Delegated read unavailable') });
        expect(await list({ query: fixture.name }, delegated)).toMatchObject({ total: 0, records: [] });
      }
      const synthetic = records.find(record => record.name === 'Synthetic Override B');
      if (synthetic) {
        const { texture, ...summary } = (await token(synthetic.id, delegated)).token;
        const native = square.tokens.find(entry => entry.id === synthetic.id)!;
        expect(summary).toEqual(synthetic);
        expect(texture).toMatchObject({ scaleX: native.scaleX, scaleY: native.scaleY });
      }
    }
    principal = a;
    const secret = square.tokens.find(entry => entry.hidden)!;
    for (const id of [secret.id, 'AAAAAAAAAAAAAAAA']) {
      await expect(delegated.callTool({ name: 'get_scene_token', arguments: { sceneId: square.id, tokenId: id } }))
        .rejects.toMatchObject({ code: ErrorCode.InternalError, message: expect.stringContaining('Delegated read unavailable') });
    }
    const denied = seed.scenes.find(scene => scene.name.endsWith('Secret Scene'))!;
    for (const name of toolNames) await expect(delegated.callTool({ name, arguments: { sceneId: denied.id,
      ...(name === 'get_scene_token' && { tokenId: square.tokens[0]!.id }) } }))
      .rejects.toMatchObject({ code: ErrorCode.InternalError, message: expect.stringContaining('Delegated read unavailable') });
  });
  it('isolates caller-bound pagination even within one authenticated MCP session', async () => {
    principal = a;
    const first = await list({ limit: 1 }, delegated);
    principal = b;
    await expect(delegated.callTool({ name: 'list_scene_tokens', arguments: { sceneId: square.id, limit: 1, cursor: first.nextCursor } }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    principal = a;
    expect((await list({ limit: 1, cursor: first.nextCursor }, delegated)).page).toBe(2);
  });
  it.each(['token-edit', 'token-hide', 'token-delete', 'scene-edit'])('invalidates snapshots after native %s broadcasts', async kind => {
    const target = square.tokens.find(entry => entry.name === (kind === 'token-delete' ? 'Grid Token 002' : 'Duplicate 😀'))!;
    const first = await list({ limit: 1 });
    await mutate(kind, square.id, target.id);
    await invalidated({ sceneId: square.id, limit: 1, cursor: first.nextCursor });
    const current = (await oracle()).scenes.find(scene => scene.id === square.id)!;
    compareTokens(await allTokens(current), current, seed.gmId);
    if (kind === 'token-edit') expect((await token(target.id)).token).toMatchObject({ xPixels: target.x + 17, rotationDegrees: 45, elevation: 0 });
    if (kind === 'token-delete') await expect(client.callTool({ name: 'get_scene_token', arguments: { sceneId: square.id, tokenId: target.id } }))
      .rejects.toMatchObject({ code: ErrorCode.InternalError });
    if (kind === 'scene-edit') expect(sceneSpatialOutputSchema.parse(await call('get_scene_spatial', { sceneId: square.id })).scene.source.widthPixels).toBe(square.width + 100);
  });
  it('resolves the active scene and invalidates implicit cursors when it changes', async () => {
    const first = sceneTokenListOutputSchema.parse(await call('list_scene_tokens', { limit: 1 }));
    const next = seed.scenes.find(scene => scene.grid.type === 0 && scene.tokens.length)!;
    await mutate('activate', next.id);
    await invalidated({ limit: 1, cursor: first.nextCursor });
    await expect.poll(async () => sceneSpatialOutputSchema.parse(await call('get_scene_spatial')).scene.id, { timeout: 15_000 }).toBe(next.id);
    expect(sceneTokenOutputSchema.parse(await call('get_scene_token', { tokenId: next.tokens[0]!.id })).scene.id).toBe(next.id);
    await mutate('activate');
    await expect.poll(async () => sceneSpatialOutputSchema.parse(await call('get_scene_spatial')).scene.id, { timeout: 15_000 }).toBe(square.id);
  });
  it('rechecks native actor and scene revocations before returning any page or detail', async () => {
    principal = a;
    const actorCursor = await list({ limit: 1 }, delegated);
    const shared = square.tokens.find(entry => entry.name === 'Grid Token 003')!;
    await mutate('actor-revoke', square.id, shared.id, a);
    await invalidated({ sceneId: square.id, limit: 1, cursor: actorCursor.nextCursor }, delegated);
    const current = (await oracle()).scenes.find(scene => scene.id === square.id)!;
    compareTokens(await allTokens(current, 100, delegated), current, a);
    await expect(delegated.callTool({ name: 'get_scene_token', arguments: { sceneId: square.id, tokenId: shared.id } }))
      .rejects.toMatchObject({ code: ErrorCode.InternalError });
    const sceneCursor = await list({ limit: 1 }, delegated);
    await mutate('scene-revoke', square.id, undefined, a);
    for (const name of toolNames) await expect(delegated.callTool({ name, arguments: { sceneId: square.id,
      ...(name === 'get_scene_token' && { tokenId: shared.id }), ...(name === 'list_scene_tokens' && { limit: 1, cursor: sceneCursor.nextCursor }) } }))
      .rejects.toMatchObject({ code: ErrorCode.InternalError });
    expect((await list()).total).toBe(257);
  });
});
