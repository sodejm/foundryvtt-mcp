/** Exercise a real Socket.IO outage without interrupting other Foundry clients. */
import { createServer, connect, type Server, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FoundryClient } from '../../src/foundry/client.js';
import { worldReadMetadataSchema } from '../../src/foundry/freshness.js';
import { createConnectedClient } from './setup.js';

type Writer = {
  modifyDocument(type: 'Actor' | 'User', action: 'create' | 'update' | 'delete', operation: Record<string, unknown>): Promise<Array<{ _id: string; name?: string }>>;
};

describe('live snapshot recovery through MCP stdio', () => {
  let writer: FoundryClient | undefined;
  let reader: FoundryClient | undefined;
  let presence: FoundryClient | undefined;
  let mcp: Client | undefined;
  let transport: StdioClientTransport | undefined;
  let proxy: Server | undefined;
  let proxyUrl = '';
  let enabled = true;
  const sockets = new Set<Socket>();
  const prefix = `MCP Recovery ${process.pid} ${Date.now()}`;
  const actors: string[] = [];
  let beforeActorId = '';
  let userId: string | undefined;
  const userName = `${prefix} Player`;

  async function waitFor(assertion: () => unknown | Promise<unknown>) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (await assertion()) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Timed out waiting for live recovery state');
  }

  function fixtureWriter(): Writer {
    if (!writer) throw new Error('Live fixture writer is required');
    return writer as unknown as Writer;
  }

  async function call(name: string, args: Record<string, unknown> = {}) {
    if (!mcp) throw new Error('MCP client is required');
    const response = await mcp.callTool({ name, arguments: args });
    expect(response.isError).not.toBe(true);
    return response;
  }

  function text(response: { content: unknown }) {
    return (response.content as Array<{ text?: string }>).map(block => block.text ?? '').join('\n');
  }

  async function readResource(uri: string) {
    const response = await mcp!.readResource({ uri });
    return JSON.parse((response.contents[0] as { text: string }).text);
  }

  function interrupt() {
    enabled = false;
    for (const socket of sockets) socket.destroy();
  }

  beforeAll(async () => {
    writer = await createConnectedClient({ writeEnabled: true });
    if (writer.getWorldData()?.world.id !== 'test1world') {
      throw new Error('Recovery fixture writes require the disposable test1world');
    }
    const createdActors = await fixtureWriter().modifyDocument('Actor', 'create', {
      data: [{ name: `${prefix} Before`, type: 'npc' }, { name: `${prefix} Other`, type: 'npc' }],
    });
    actors.push(...createdActors.map(document => document._id));
    beforeActorId = createdActors.find(document => document.name === `${prefix} Before`)?._id ?? '';
    if (!beforeActorId) throw new Error('Expected the named recovery fixture actor in the create response');
    [userId] = (await fixtureWriter().modifyDocument('User', 'create', {
      data: [{ name: userName, role: 1, password: '' }],
    })).map(document => document._id);

    const upstream = new URL(process.env.FOUNDRY_URL ?? 'http://127.0.0.1:30001');
    if (upstream.protocol !== 'http:') throw new Error('Recovery proxy requires a local HTTP test server');
    proxy = createServer(downstream => {
      if (!enabled) return downstream.destroy();
      const upstreamSocket = connect(Number(upstream.port || 80), upstream.hostname);
      for (const socket of [downstream, upstreamSocket]) {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
        socket.on('error', () => {
          downstream.destroy();
          upstreamSocket.destroy();
        });
      }
      downstream.once('close', () => upstreamSocket.destroy());
      upstreamSocket.once('close', () => downstream.destroy());
      downstream.pipe(upstreamSocket).pipe(downstream);
    });
    await new Promise<void>((resolve, reject) => {
      proxy!.once('error', reject);
      proxy!.listen(0, '127.0.0.1', resolve);
    });
    const address = proxy.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP proxy address');
    proxyUrl = `http://127.0.0.1:${address.port}`;
    reader = await createConnectedClient({ baseUrl: proxyUrl, timeout: 3000 });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('../../dist/index.js', import.meta.url))],
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      stderr: 'pipe',
      env: Object.fromEntries(Object.entries({
        ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'error', FOUNDRY_URL: proxyUrl,
        FOUNDRY_USERNAME: process.env.FOUNDRY_USERNAME ?? 'Gamemaster',
        FOUNDRY_PASSWORD: process.env.FOUNDRY_PASSWORD ?? '',
      }).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    });
    transport.stderr?.on('data', () => {});
    mcp = new Client({ name: 'live-recovery-integration', version: '1.0.0' });
    await mcp.connect(transport);
    await waitFor(async () => (await call('get_health_status')).structuredContent?.connected === true);
  });

  afterAll(async () => {
    enabled = true;
    await Promise.allSettled([mcp?.close(), transport?.close(), reader?.disconnect(), presence?.disconnect()]);
    try {
      if (writer) {
        if (actors.length) await fixtureWriter().modifyDocument('Actor', 'delete', { ids: actors });
        if (userId) await fixtureWriter().modifyDocument('User', 'delete', { ids: [userId] });
      }
    } finally {
      await writer?.disconnect();
      for (const socket of sockets) socket.destroy();
      if (proxy) await new Promise<void>(resolve => proxy!.close(() => resolve()));
    }
  });

  it('keeps source clocks stable on repeated reads', async () => {
    const first = worldReadMetadataSchema.parse((await call('get_actor_details', { actorId: beforeActorId })).structuredContent?.readMetadata);
    await new Promise(resolve => setTimeout(resolve, 20));
    const second = worldReadMetadataSchema.parse((await call('get_actor_details', { actorId: beforeActorId })).structuredContent?.readMetadata);
    expect(first).toMatchObject({ source: 'socket', freshness: 'current', worldId: 'test1world' });
    expect({ ...second, respondedAt: first.respondedAt }).toEqual(first);
    expect(Date.parse(second.respondedAt)).toBeGreaterThan(Date.parse(first.respondedAt));
  });

  it('recovers missed documents and presence, invalidates cursors, and fences a new session', async () => {
    const page = await call('search_actors', { query: prefix, limit: 1 });
    const before = worldReadMetadataSchema.parse(page.structuredContent?.readMetadata);
    const cursor = page.structuredContent?.nextCursor;
    expect(cursor).toEqual(expect.any(String));
    const localPage = await reader!.searchActors({ query: prefix, limit: 1 });
    const localSession = reader!.getReadMetadata().sessionId;
    expect(reader!.getUsers().activeUsers).not.toContain(userId);

    interrupt();
    await waitFor(() => !reader!.isConnected());
    await waitFor(async () => (await call('get_health_status')).structuredContent?.connected === false);
    await fixtureWriter().modifyDocument('Actor', 'update', {
      updates: [{ _id: beforeActorId, name: `${prefix} After` }],
    });
    presence = await createConnectedClient({ username: userName, password: '' });
    await waitFor(() => writer!.getUsers().activeUsers.includes(userId!));

    for (const [name, args] of [
      ['search_actors', { query: prefix }], ['get_actor_details', { actorId: beforeActorId }],
      ['get_users', {}], ['get_world_summary', {}], ['get_combat_state', {}],
      ['get_chat_messages', {}], ['get_scene_info', {}], ['get_health_status', {}],
    ] as const) {
      const response = await call(name, args);
      const metadata = worldReadMetadataSchema.parse(response.structuredContent?.readMetadata);
      expect(metadata, name).toMatchObject({ ...before, freshness: 'stale', respondedAt: expect.any(String) });
      expect(text(response), name).toContain('stale');
    }
    const staleDetails = await call('get_actor_details', { actorId: beforeActorId });
    expect(text(staleDetails)).toContain(`${prefix} Before`);
    const stalePresence = await call('get_users');
    expect(text(stalePresence)).toContain(`**${userName}** (Player) — Offline`);
    for (const uri of ['foundry://actors', 'foundry://world/settings', 'foundry://scenes/current', 'foundry://combat']) {
      expect(worldReadMetadataSchema.parse((await readResource(uri)).readMetadata), uri).toMatchObject({
        freshness: 'stale', worldId: before.worldId, snapshotId: before.snapshotId,
      });
    }
    await expect(mcp!.callTool({ name: 'search_actors', arguments: { query: prefix, limit: 1, cursor } })).rejects.toThrow(/cursor|snapshot/i);
    await expect(reader!.searchActors({ query: prefix, limit: 1, cursor: localPage.nextCursor! })).rejects.toThrow(/cursor|snapshot/i);

    enabled = true;
    await waitFor(() => reader!.getReadMetadata().freshness === 'current');
    await waitFor(async () => (await call('get_health_status')).structuredContent?.readMetadata.freshness === 'current');
    const recovered = await call('get_actor_details', { actorId: beforeActorId });
    const after = worldReadMetadataSchema.parse(recovered.structuredContent?.readMetadata);
    expect(text(recovered)).toContain(`${prefix} After`);
    expect(after).toMatchObject({ freshness: 'current', sessionId: before.sessionId, worldId: 'test1world' });
    expect(after.snapshotId).not.toBe(before.snapshotId);
    expect(after.revision).toBeGreaterThan(before.revision);
    expect(Date.parse(after.capturedAt!)).toBeGreaterThan(Date.parse(before.capturedAt!));
    expect(reader!.getUsers().activeUsers).toContain(userId);
    expect(text(await call('get_users'))).toContain(`**${userName}** (Player) — Online`);
    const health = (await call('get_health_status')).structuredContent!;
    expect(health.connected).toBe(true);
    expect(health.restDiagnostics).toMatchObject({ source: 'rest', freshness: 'unavailable', capturedAt: null, observedAt: null });

    const next = await reader!.searchActors({ query: prefix, limit: 1 });
    await reader!.disconnect();
    expect(reader!.getReadMetadata()).toMatchObject({ freshness: 'unavailable', worldId: null, snapshotId: null, capturedAt: null, observedAt: null });
    expect(() => reader!.getUsers()).toThrow(/unavailable|not loaded/i);
    await expect(reader!.searchActors({ query: prefix })).rejects.toThrow(/unavailable|not loaded/i);
    await reader!.connect();
    expect(reader!.getReadMetadata().sessionId).not.toBe(localSession);
    expect(reader!.getReadMetadata()).toMatchObject({ freshness: 'current', worldId: 'test1world' });
    await expect(reader!.searchActors({ query: prefix, limit: 1, cursor: next.nextCursor! })).rejects.toThrow(/cursor|snapshot/i);
    expect(reader!.getUsers().activeUsers).toContain(userId);
    expect(text(await call('refresh_world_data'))).toContain('current');
  }, 80_000);
});
