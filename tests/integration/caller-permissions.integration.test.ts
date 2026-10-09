/** Real Foundry permission oracles plus the built MCP transport boundary. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { chromium, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FoundryMCPServer } from '../../dist/index.js';
import { FoundryClient as BuiltFoundryClient } from '../../dist/foundry/client.js';
import { authenticateFoundry } from '../../src/foundry/auth.js';
import type { FoundryClient } from '../../src/foundry/client.js';
import { createConnectedClient } from './setup.js';

type RecordData = Record<string, unknown> & { _id: string; name?: string };
type Writer = {
  modifyDocument(type: string, action: 'create' | 'update' | 'delete', operation: Record<string, unknown>): Promise<RecordData[]>;
};

describe('live delegated caller permissions', () => {
  const prefix = `MCP Caller ${process.pid} ${Date.now()}`;
  const owned = new Map<string, Set<string>>();
  const actors: string[] = [];
  const items: string[] = [];
  const journals: string[] = [];
  const messages: string[] = [];
  const pages = new Map<string, Page>();
  let writer: FoundryClient | undefined;
  let backend: InstanceType<typeof BuiltFoundryClient> | undefined;
  let browser: Browser | undefined;
  let server: FoundryMCPServer | undefined;
  let mcp: Client | undefined;
  let a = '';
  let b = '';
  let gm = '';
  let journalA = '';
  let journalShared = '';
  let secretEmbedded = '';
  let visibleEmbedded = '';
  let sceneId = '';
  let token = 'a';
  let sessionId = 'live-caller-session';
  let worldId = 'test1world';

  const context = (userId: string) => ({ callerId: `live:${userId}`, userId, worldId, sessionId });
  const owner = (userId: string) => ({ default: 0, [userId]: 2 });
  const fixtureWriter = () => writer as unknown as Writer;
  async function create(type: string, data: Record<string, unknown>, parentUuid?: string) {
    const result = await fixtureWriter().modifyDocument(type, 'create', { data: [data], ...(parentUuid && { parentUuid }) });
    if (!parentUuid) {
      const ids = owned.get(type) ?? new Set<string>();
      for (const record of result) ids.add(record._id);
      owned.set(type, ids);
    }
    expect(result).toHaveLength(1);
    return result[0]!;
  }
  async function update(type: string, data: Record<string, unknown>) {
    await fixtureWriter().modifyDocument(type, 'update', { updates: [data] });
  }
  async function call(name: string, args: Record<string, unknown> = {}) {
    const result = await mcp!.callTool({ name, arguments: args });
    expect(result.isError).not.toBe(true);
    return result;
  }
  async function resource(uri: string) {
    const result = await mcp!.readResource({ uri });
    return JSON.parse((result.contents[0] as { text: string }).text);
  }
  async function waitFor(assertion: () => Promise<boolean>) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (await assertion()) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Timed out waiting for the Foundry permission oracle');
  }
  async function openPlayer(userId: string, password: string) {
    const baseUrl = process.env.FOUNDRY_URL ?? 'http://127.0.0.1:30001';
    const authenticated = await authenticateFoundry(baseUrl, userId, password);
    const browserContext = await browser!.newContext();
    await browserContext.addCookies([{ name: 'session', value: authenticated.session, url: baseUrl }]);
    const page = await browserContext.newPage();
    await page.goto(`${baseUrl}/game`);
    await page.waitForFunction(() => (globalThis as any).game?.ready === true);
    expect(await page.evaluate(() => (globalThis as any).game.user.id)).toBe(userId);
    pages.set(userId, page);
  }
  async function oracle(collection: string, ids: string[], userId: string) {
    return pages.get(gm)!.evaluate(({ collection, ids, userId }) => {
      const game = (globalThis as any).game;
      const user = game.users.get(userId);
      return ids.filter(id => game[collection].get(id)?.testUserPermission(user, 'OBSERVER'));
    }, { collection, ids, userId });
  }

  beforeAll(async () => {
    writer = await createConnectedClient({ writeEnabled: true });
    const world = writer.getWorldData();
    if (world?.world.id !== 'test1world' || world.system.id !== 'dnd5e') {
      throw new Error('Caller mutation tests require the disposable dnd5e test1world');
    }
    gm = world.userId;
    a = (await create('User', { name: `${prefix} Player A`, role: 1, password: '' }))._id;
    b = (await create('User', { name: `${prefix} Player B`, role: 1, password: '' }))._id;
    for (const [label, ownership] of [
      ['A One', owner(a)], ['A Two', owner(a)], ['B One', owner(b)], ['B Two', owner(b)],
      ['Default Observer', { default: 2, [b]: 0 }], ['Limited', { default: 1 }], ['Secret', { default: 0 }],
    ] as const) {
      actors.push((await create('Actor', { name: `${prefix} ${label}`, type: 'npc', ownership }))._id);
    }
    visibleEmbedded = (await create('Item', { name: `${prefix} Inherited Gear`, type: 'loot', ownership: { default: -1 } }, `Actor.${actors[0]}`))._id;
    secretEmbedded = (await create('Item', { name: `${prefix} Secret Gear`, type: 'loot', ownership: owner(b) }, `Actor.${actors[0]}`))._id;
    for (const userId of [a, b]) {
      items.push((await create('Item', { name: `${prefix} Item ${userId}`, type: 'loot', ownership: owner(userId) }))._id);
    }
    journalA = (await create('JournalEntry', {
      name: `${prefix} Journal A`, ownership: owner(a), pages: [
        { name: `${prefix} Inherited Page`, type: 'text', ownership: { default: -1 }, text: { content: '<p>Visible inherited text</p>' } },
        { name: `${prefix} Secret Page`, type: 'text', ownership: owner(b), text: { content: '<p>Secret page text</p>' } },
      ],
    }))._id;
    journals.push(journalA);
    journals.push((await create('JournalEntry', { name: `${prefix} Journal B`, ownership: owner(b) }))._id);
    journalShared = (await create('JournalEntry', {
      name: `${prefix} Shared Journal`, ownership: { default: 2 }, pages: [
        { name: `${prefix} A Page`, type: 'text', ownership: owner(a), text: { content: '<p>A shared entry text</p>' } },
        { name: `${prefix} B Page`, type: 'text', ownership: owner(b), text: { content: '<p>B shared entry text</p>' } },
      ],
    }))._id;
    journals.push(journalShared);
    sceneId = (await create('Scene', { name: `${prefix} Secret Scene`, active: false, width: 1000, height: 1000 }))._id;
    await create('Token', { name: `${prefix} Hidden Token`, actorId: actors[0], actorLink: true, hidden: true, x: 100, y: 200 }, `Scene.${sceneId}`);
    for (const [label, author, whisper, blind] of [
      ['Public', gm, [], false], ['Whisper A', gm, [a], false], ['Whisper B', gm, [b], false],
      ['Blind Author A', a, [gm], true], ['Own Whisper A', a, [gm], false],
    ] as const) {
      messages.push((await create('ChatMessage', { author, content: `<p>${prefix} ${label}</p>`, whisper, blind }))._id);
    }
    browser = await chromium.launch({ headless: true });
    await openPlayer(gm, process.env.FOUNDRY_PASSWORD ?? '');
    await openPlayer(a, '');
    await openPlayer(b, '');
    backend = new BuiltFoundryClient({
      baseUrl: process.env.FOUNDRY_URL ?? 'http://127.0.0.1:30001',
      username: process.env.FOUNDRY_USERNAME ?? 'Gamemaster', password: process.env.FOUNDRY_PASSWORD ?? '',
      authorizationMode: 'delegated', timeout: 15_000,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    serverTransport.sessionId = sessionId;
    const send = clientTransport.send.bind(clientTransport);
    clientTransport.send = (message, options) => send(message, {
      ...options, authInfo: { token, clientId: 'live-host', scopes: ['foundry:read'] },
    });
    server = new FoundryMCPServer({ foundryClient: backend, resolveCaller: metadata => {
      const userId = ({ a, b, gm } as Record<string, string>)[metadata.authInfo?.token ?? ''];
      return userId ? context(userId) : undefined;
    } });
    await server.start(serverTransport);
    mcp = new Client({ name: 'live-caller-permissions', version: '1' });
    await mcp.connect(clientTransport);
  });

  afterAll(async () => {
    const errors: unknown[] = [];
    for (const result of await Promise.allSettled([mcp?.close(), server?.shutdown(), browser?.close()])) {
      if (result.status === 'rejected') errors.push(result.reason);
    }
    try {
      if (writer) for (const [type, ids] of [...owned].reverse()) {
        if (!ids.size) continue;
        try { await fixtureWriter().modifyDocument(type, 'delete', { ids: [...ids] }); }
        catch (error) { errors.push(error); }
      }
    } finally { await writer?.disconnect(); }
    if (errors.length) throw new AggregateError(errors, 'Owned caller fixture cleanup failed');
  });

  for (const principal of ['a', 'b', 'gm'] as const) {
    it(`matches Foundry OBSERVER permissions for ${principal} searches and resources`, async () => {
      token = principal;
      const userId = { a, b, gm }[principal];
      for (const [collection, ids, tool, uri] of [
        ['actors', actors, 'search_actors', 'foundry://actors'],
        ['items', items, 'search_items', 'foundry://items'],
        ['journal', journals, 'search_journals', 'foundry://journals'],
      ] as const) {
        const expected = (await oracle(collection, [...ids], userId)).sort();
        const response = (await call(tool, { query: prefix })).structuredContent!;
        expect(response.records.map((record: { id: string }) => record.id).sort()).toEqual(expected);
        expect(response.total).toBe(expected.length);
        const page = await resource(uri);
        expect(page.records.filter((record: { id: string }) => ids.includes(record.id)).map((record: { id: string }) => record.id).sort()).toEqual(expected);
      }
      const worldSearch = (await call('search_world', { query: prefix, limit: 100 })).structuredContent!;
      const expected = (await Promise.all([
        oracle('actors', actors, userId), oracle('items', items, userId), oracle('journal', journals, userId),
      ])).flat().sort();
      expect(worldSearch.records.map((record: { id: string }) => record.id).sort()).toEqual(expected);
      expect(JSON.stringify(worldSearch)).not.toContain('Hidden Token');
      const users = await resource('foundry://users');
      expect(users.records).toHaveLength(1);
      expect(users.records[0].id).toBe(userId);
      const summary = JSON.stringify(await call('get_world_summary'));
      for (const unsupported of ['scenes', 'combats', 'packs', 'settings']) expect(summary).not.toContain(`**${unsupported}**`);
    });

    it(`matches actual ${principal} chat visibility without whisper or blind-roll disclosure`, async () => {
      token = principal;
      const userId = { a, b, gm }[principal];
      const expected = await pages.get(userId)!.evaluate(ids => {
        const game = (globalThis as any).game;
        return ids.filter(id => game.messages.get(id)?.isContentVisible === true);
      }, messages);
      const projected = await backend!.runWithCaller(context(userId), () => backend!.getWorldData()!.messages);
      expect(projected.filter(message => messages.includes(message._id)).map(message => message._id).sort()).toEqual(expected.sort());
      const response = JSON.stringify(await call('get_chat_messages', { limit: 100 }));
      for (const message of writer!.getWorldData()!.messages.filter(message => messages.includes(message._id))) {
        expect(response.includes(message.content.replace(/<[^>]+>/g, '')), message._id).toBe(expected.includes(message._id));
      }
    });
  }

  it('requires parent and page access and applies inherited embedded-item ownership', async () => {
    token = 'a';
    const ownJournal = JSON.stringify(await call('get_journal', { journalId: journalA }));
    expect(ownJournal).toContain('Visible inherited text');
    expect(ownJournal).not.toContain('Secret page text');
    const sharedA = JSON.stringify(await call('get_journal', { journalId: journalShared }));
    expect(sharedA).toContain('A shared entry text');
    expect(sharedA).not.toContain('B shared entry text');
    const embedded = await backend!.runWithCaller(context(a), () => backend!.getWorldData()!.actors.find(actor => actor._id === actors[0])!.items);
    expect(embedded.map(item => item._id)).toContain(visibleEmbedded);
    expect(embedded.map(item => item._id)).not.toContain(secretEmbedded);
    token = 'b';
    await expect(call('get_journal', { journalId: journalA })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    const sharedB = JSON.stringify(await call('get_journal', { journalId: journalShared }));
    expect(sharedB).toContain('B shared entry text');
    expect(sharedB).not.toContain('A shared entry text');
  });

  it('serves visible direct IDs and returns indistinguishable errors for hidden and absent IDs', async () => {
    token = 'a';
    for (const [name, key, visible, hidden] of [
      ['get_actor_details', 'actorId', actors[0], actors[2]],
      ['get_item_details', 'itemId', items[0], items[1]],
      ['get_journal', 'journalId', journalA, journals[1]],
    ] as const) {
      expect(JSON.stringify(await call(name, { [key]: visible }))).toContain(visible);
      const errorFor = async (id: string) => {
        try { await call(name, { [key]: id }); throw new Error('Expected a denied document'); }
        catch (error) { return { code: (error as any).code, message: (error as Error).message }; }
      };
      const hiddenError = await errorFor(hidden);
      expect(hiddenError).toEqual(await errorFor('zzzzzzzzzzzzzzzz'));
      expect(hiddenError.message).not.toContain(hidden);
      expect(hiddenError.code).toBeLessThan(0);
    }
  });

  it('filters before pagination and fences cursor reuse by caller, world, and session', async () => {
    token = 'a';
    const first = (await call('search_actors', { query: prefix, limit: 1 })).structuredContent!;
    expect(first.total).toBe(3);
    expect(first.nextCursor).toEqual(expect.any(String));
    const ids = first.records.map((record: { id: string }) => record.id);
    let cursor = first.nextCursor;
    while (cursor) {
      const next = (await call('search_actors', { query: prefix, limit: 1, cursor })).structuredContent!;
      ids.push(...next.records.map((record: { id: string }) => record.id));
      cursor = next.nextCursor;
    }
    expect(ids.sort()).toEqual((await oracle('actors', actors, a)).sort());
    token = 'b';
    await expect(call('search_actors', { query: prefix, limit: 1, cursor: first.nextCursor })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    token = 'a';
    try {
      sessionId = 'new-authenticated-session';
      await expect(call('search_actors', { query: prefix, limit: 1, cursor: first.nextCursor })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
      sessionId = 'live-caller-session';
      worldId = 'other-world';
      await expect(call('search_actors', { query: prefix })).rejects.toMatchObject({ code: ErrorCode.InvalidRequest });
    } finally {
      sessionId = 'live-caller-session';
      worldId = 'test1world';
    }
    const page = await resource('foundry://actors?limit=1');
    expect(page.nextUri).toEqual(expect.any(String));
    token = 'b';
    await expect(resource(page.nextUri)).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it('honors immediate revocation and invalidates previously authorized cursors', async () => {
    token = 'a';
    const first = (await call('search_actors', { query: prefix, limit: 1 })).structuredContent!;
    try {
      await update('Actor', { _id: actors[0], ownership: { default: 0, [a]: 0 } });
      await waitFor(async () => !(await oracle('actors', [actors[0]], a)).length);
      const after = (await call('search_actors', { query: prefix })).structuredContent!;
      expect(after.total).toBe(2);
      expect(JSON.stringify(after)).not.toContain(actors[0]);
      await expect(call('get_actor_details', { actorId: actors[0] })).rejects.toMatchObject({ code: ErrorCode.InternalError });
      await expect(call('search_actors', { query: prefix, limit: 1, cursor: first.nextCursor })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    } finally { await update('Actor', { _id: actors[0], ownership: owner(a) }); }
  });

  it('denies unknown authentication, forged arguments, unsupported reads, and every delegated write', async () => {
    token = 'unknown';
    await expect(call('search_actors')).rejects.toMatchObject({ code: ErrorCode.InvalidRequest });
    token = 'a';
    await expect(call('search_actors', { userId: gm, role: 4 })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(resource(`foundry://actors?userId=${gm}`)).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    expect(JSON.stringify(await mcp!.callTool({ name: 'search_actors', arguments: { query: prefix }, _meta: { userId: gm, role: 4 } }))).not.toContain(`${prefix} Secret`);
    for (const principal of ['a', 'gm']) {
      token = principal;
      for (const name of ['get_scene_info', 'get_token_details', 'get_combat_state', 'search_compendium', 'get_capabilities', 'get_rules', 'get_system_diagnostics', 'create_actor', 'add_item_to_actor', 'refresh_world_data']) {
        await expect(call(name, { sceneId })).rejects.toMatchObject({ code: ErrorCode.InvalidRequest });
      }
      await expect(resource('foundry://world/settings')).rejects.toMatchObject({ code: ErrorCode.InvalidRequest });
    }
  });

  it('fails closed on backend disconnect, then resumes fresh reads after reconnect', async () => {
    token = 'a';
    const first = (await call('search_actors', { query: prefix, limit: 1 })).structuredContent!;
    await backend!.disconnect();
    await expect(call('search_actors', { query: prefix })).rejects.toMatchObject({ code: ErrorCode.InvalidRequest });
    await expect(resource('foundry://actors')).rejects.toMatchObject({ code: ErrorCode.InvalidRequest });
    await backend!.connect();
    expect((await call('search_actors', { query: prefix })).structuredContent!.total).toBe(3);
    await expect(call('search_actors', { query: prefix, limit: 1, cursor: first.nextCursor })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it('rejects banned and removed world members without using the backend GM identity', async () => {
    token = 'b';
    try {
      await update('User', { _id: b, role: 0 });
      await expect(call('search_actors', { query: prefix })).rejects.toMatchObject({ code: ErrorCode.InvalidRequest });
      await expect(resource('foundry://actors')).rejects.toMatchObject({ code: ErrorCode.InvalidRequest });
    } finally { await update('User', { _id: b, role: 1 }); }
    expect((await call('search_actors', { query: prefix })).structuredContent!.total).toBe(2);
    await pages.get(b)!.context().close();
    await fixtureWriter().modifyDocument('User', 'delete', { ids: [b] });
    owned.get('User')!.delete(b);
    await expect(call('search_actors', { query: prefix })).rejects.toMatchObject({ code: ErrorCode.InvalidRequest });
  });
});
