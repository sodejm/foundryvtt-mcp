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
  let journalAInheritedPage = '';
  let journalASecretPage = '';
  let sharedAPage = '';
  let sharedBPage = '';
  let sharedLongPage = '';
  let sharedHiddenImagePage = '';
  let sharedHiddenVideoPage = '';
  const sharedSummaryPages: string[] = [];
  const longJournalText = `${prefix} long page opening\n${'journal-content-'.repeat(500)}`;
  const editedLongJournalText = `${prefix} edited long page opening\n${'updated-content-'.repeat(500)}`;
  const hiddenImageSrc = `/caller-fixtures/${process.pid}-hidden-image.webp`;
  const hiddenVideoSrc = `/caller-fixtures/${process.pid}-hidden-video.webm`;
  const hiddenImageCaption = `${prefix} hidden image caption`;
  let secretEmbedded = '';
  let visibleEmbedded = '';
  let secondVisibleEmbedded = '';
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
  async function update(type: string, data: Record<string, unknown>, parentUuid?: string) {
    await fixtureWriter().modifyDocument(type, 'update', {
      updates: [data],
      ...(parentUuid && { parentUuid }),
    });
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
    const browserContext = await browser!.newContext({ viewport: { width: 1366, height: 768 } });
    // These browsers exercise document permissions, so Foundry's client-only
    // no-canvas setting avoids unrelated headless WebGL initialization failures.
    await browserContext.addInitScript(() => localStorage.setItem('core.noCanvas', 'true'));
    await browserContext.addCookies([{ name: 'session', value: authenticated.session, url: baseUrl }]);
    const page = await browserContext.newPage();
    await page.goto(`${baseUrl}/game`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForFunction(() => (globalThis as any).game?.ready === true
      || !!document.querySelector('#login-form'), null, { polling: 100, timeout: 60_000 });
    if (await page.locator('#login-form').count()) {
      await page.locator('select[name="userid"]').selectOption(userId);
      await page.locator('input[name="password"]').fill(password);
      await page.locator('button[data-action="join"]').click();
    }
    await page.waitForFunction(() => (globalThis as any).game?.ready === true, null, { polling: 100, timeout: 60_000 });
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
  async function journalPageOracle(journalId: string, ids: string[], userId: string) {
    return pages.get(gm)!.evaluate(({ journalId, ids, userId }) => {
      const game = (globalThis as any).game;
      const user = game.users.get(userId);
      const journal = game.journal.get(journalId);
      if (!journal?.testUserPermission(user, 'OBSERVER')) return [];
      return ids.filter(id => journal.pages.get(id)?.testUserPermission(user, 'OBSERVER'));
    }, { journalId, ids, userId });
  }
  async function toolError(name: string, args: Record<string, unknown>) {
    try {
      await call(name, args);
      throw new Error('Expected the journal read to fail');
    } catch (error) {
      return { code: (error as any).code, message: (error as Error).message };
    }
  }
  async function collectJournalSummary(journalId: string, limit = 2) {
    const records: Array<Record<string, unknown>> = [];
    let cursor: string | undefined;
    let first: Record<string, any> | undefined;
    do {
      const response = (await call('get_journal', {
        journalId,
        limit,
        ...(cursor && { cursor }),
      })).structuredContent as Record<string, any>;
      first ??= response;
      records.push(...response.pages);
      cursor = response.nextCursor;
    } while (cursor);
    return { first: first!, records };
  }
  async function collectJournalPage(
    journalId: string,
    pageId: string,
    format: 'text' | 'source',
    limit = 2,
  ) {
    const chunks: Array<{ content: string }> = [];
    let cursor: string | undefined;
    let first: Record<string, any> | undefined;
    do {
      const response = (await call('get_journal_page', {
        journalId,
        pageId,
        format,
        limit,
        ...(cursor && { cursor }),
      })).structuredContent as Record<string, any>;
      first ??= response;
      chunks.push(...response.chunks);
      cursor = response.nextCursor;
    } while (cursor);
    return { first: first!, content: chunks.map(chunk => chunk.content).join('') };
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
    secondVisibleEmbedded = (await create('Item', { name: `${prefix} Second Inherited Gear`, type: 'loot', ownership: { default: -1 }, system: { quantity: 0 } }, `Actor.${actors[0]}`))._id;
    secretEmbedded = (await create('Item', { name: `${prefix} Secret Gear`, type: 'loot', ownership: owner(b) }, `Actor.${actors[0]}`))._id;
    for (const userId of [a, b]) {
      items.push((await create('Item', { name: `${prefix} Item ${userId}`, type: 'loot', ownership: owner(userId) }))._id);
    }
    journalA = (await create('JournalEntry', { name: `${prefix} Journal A`, ownership: owner(a) }))._id;
    journals.push(journalA);
    journalAInheritedPage = (await create('JournalEntryPage', {
      name: `${prefix} Inherited Page`,
      type: 'text',
      ownership: { default: -1 },
      text: { format: 1, content: '<p>Visible inherited text</p>' },
    }, `JournalEntry.${journalA}`))._id;
    journalASecretPage = (await create('JournalEntryPage', {
      name: `${prefix} Secret Page`,
      type: 'text',
      ownership: owner(b),
      text: { format: 1, content: '<p>Secret page text</p>' },
    }, `JournalEntry.${journalA}`))._id;
    journals.push((await create('JournalEntry', { name: `${prefix} Journal B`, ownership: owner(b) }))._id);
    journalShared = (await create('JournalEntry', {
      name: `${prefix} Shared Journal`, ownership: { default: 2 },
    }))._id;
    journals.push(journalShared);
    sharedAPage = (await create('JournalEntryPage', {
      name: `${prefix} A Page`,
      type: 'text',
      sort: 100_000,
      ownership: owner(a),
      text: { format: 1, content: '<p>A shared entry text</p>' },
    }, `JournalEntry.${journalShared}`))._id;
    sharedBPage = (await create('JournalEntryPage', {
      name: `${prefix} B Page`,
      type: 'text',
      sort: 200_000,
      ownership: owner(b),
      text: { format: 1, content: '<p>B shared entry text</p>' },
    }, `JournalEntry.${journalShared}`))._id;
    sharedLongPage = (await create('JournalEntryPage', {
      name: `${prefix} Shared Long Page`,
      type: 'text',
      sort: 300_000,
      ownership: { default: -1 },
      text: { format: 2, markdown: longJournalText },
    }, `JournalEntry.${journalShared}`))._id;
    for (let index = 1; index <= 6; index += 1) {
      sharedSummaryPages.push((await create('JournalEntryPage', {
        name: `${prefix} Shared Summary ${index}`,
        type: 'text',
        sort: (index + 3) * 100_000,
        ownership: { default: -1 },
        text: { format: 2, markdown: `${prefix} summary page ${index}` },
      }, `JournalEntry.${journalShared}`))._id);
    }
    sharedHiddenImagePage = (await create('JournalEntryPage', {
      name: `${prefix} Hidden Image Page`,
      type: 'image',
      sort: 1_000_000,
      ownership: owner(b),
      src: hiddenImageSrc,
      image: { caption: hiddenImageCaption },
    }, `JournalEntry.${journalShared}`))._id;
    sharedHiddenVideoPage = (await create('JournalEntryPage', {
      name: `${prefix} Hidden Video Page`,
      type: 'video',
      sort: 1_100_000,
      ownership: owner(b),
      src: hiddenVideoSrc,
      video: { controls: true, volume: 0.5 },
    }, `JournalEntry.${journalShared}`))._id;
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
    const runtime = await pages.get(gm)!.evaluate(() => {
      const game = (globalThis as any).game;
      return {
        foundry: game.version ?? game.release?.version,
        systemId: game.system.id,
        systemVersion: game.system.version,
      };
    });
    console.info(
      `Caller permissions runtime Foundry ${runtime.foundry}, ${runtime.systemId} ${runtime.systemVersion}`,
    );
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

  it('returns only OBSERVER-readable journal-page metadata, content, and assets', async () => {
    token = 'a';
    const allSharedPages = [
      sharedAPage,
      sharedBPage,
      sharedLongPage,
      ...sharedSummaryPages,
      sharedHiddenImagePage,
      sharedHiddenVideoPage,
    ];
    const expectedA = (await journalPageOracle(journalShared, allSharedPages, a)).sort();
    const summaryA = await collectJournalSummary(journalShared);
    expect(summaryA.first.schemaVersion).toBe(3);
    expect(summaryA.first.id).toBe(journalShared);
    expect(summaryA.first.uuid).toBe(`JournalEntry.${journalShared}`);
    expect(summaryA.first.total).toBe(expectedA.length);
    expect(summaryA.records.map(page => page.id).sort()).toEqual(expectedA);
    const serializedA = JSON.stringify(summaryA.records);
    for (const hidden of [
      sharedBPage,
      sharedHiddenImagePage,
      sharedHiddenVideoPage,
      hiddenImageSrc,
      hiddenVideoSrc,
      hiddenImageCaption,
    ]) expect(serializedA).not.toContain(hidden);

    const inherited = await collectJournalPage(journalA, journalAInheritedPage, 'source');
    expect(inherited.first.journalId).toBe(journalA);
    expect(inherited.first.page.id).toBe(journalAInheritedPage);
    expect(inherited.first.page.uuid).toBe(
      `JournalEntry.${journalA}.JournalEntryPage.${journalAInheritedPage}`,
    );
    expect(inherited.content).toBe('<p>Visible inherited text</p>');
    const completeLongPage = await collectJournalPage(journalShared, sharedLongPage, 'source', 1);
    expect(completeLongPage.first.schemaVersion).toBe(1);
    expect(completeLongPage.first.format).toBe('source');
    expect(completeLongPage.first.page.id).toBe(sharedLongPage);
    expect(completeLongPage.first.page.uuid).toBe(
      `JournalEntry.${journalShared}.JournalEntryPage.${sharedLongPage}`,
    );
    expect(completeLongPage.first.contentLength).toBe(Array.from(longJournalText).length);
    expect(completeLongPage.content).toBe(longJournalText);

    token = 'b';
    const expectedB = (await journalPageOracle(journalShared, allSharedPages, b)).sort();
    const summaryB = await collectJournalSummary(journalShared);
    expect(summaryB.first.total).toBe(expectedB.length);
    expect(summaryB.records.map(page => page.id).sort()).toEqual(expectedB);
    for (const [pageId, src, type] of [
      [sharedHiddenImagePage, hiddenImageSrc, 'image'],
      [sharedHiddenVideoPage, hiddenVideoSrc, 'video'],
    ] as const) {
      const asset = (await call('get_journal_page', {
        journalId: journalShared,
        pageId,
        format: 'source',
      })).structuredContent as Record<string, any>;
      expect(asset.page).toMatchObject({
        id: pageId,
        uuid: `JournalEntry.${journalShared}.JournalEntryPage.${pageId}`,
        type,
        asset: type === 'image' ? { src, caption: hiddenImageCaption } : { src },
      });
      expect(asset).toMatchObject({ contentLength: 0, chunks: [], complete: true });
    }
  });

  it('uses indistinguishable errors for denied parents, denied pages, and absent pages', async () => {
    token = 'a';
    const deniedPage = await toolError('get_journal_page', {
      journalId: journalA,
      pageId: journalASecretPage,
    });
    const deniedParent = await toolError('get_journal_page', {
      journalId: journals[1],
      pageId: sharedBPage,
    });
    const absentPage = await toolError('get_journal_page', {
      journalId: journalShared,
      pageId: 'zzzzzzzzzzzzzzzz',
    });
    expect(deniedPage).toEqual(deniedParent);
    expect(deniedPage).toEqual(absentPage);
    expect(deniedPage.code).toBe(ErrorCode.InvalidParams);
    for (const sensitive of [journalASecretPage, journals[1], hiddenImageSrc, hiddenVideoSrc]) {
      expect(deniedPage.message).not.toContain(sensitive);
    }
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

  it('exposes only observer-readable actor sheets and embedded items through the built tools', async () => {
    token = 'a';
    for (const [name, extra] of [
      ['get_actor_sheet', {}], ['get_actor_section', { section: 'attributes' }],
    ] as const) {
      const response = (await call(name, { actorId: actors[0], ...extra })).structuredContent as Record<string, any>;
      expect(response.actor.id).toBe(actors[0]);
      expect(response.actor.uuid).toBe(`Actor.${actors[0]}`);
      expect(response.system).toMatchObject({ id: 'dnd5e', version: '6.0.6', profile: 'dnd5e' });
      const denied = await toolError(name, { actorId: actors[2], ...extra });
      expect(denied).toEqual(await toolError(name, { actorId: 'zzzzzzzzzzzzzzzz', ...extra }));
      expect(denied.message).not.toContain(actors[2]);
    }
    const response = (await call('list_actor_items', { actorId: actors[0] })).structuredContent as Record<string, any>;
    const nativePermissions = await pages.get(gm)!.evaluate(({ actorId, userId }) => {
      const game = (globalThis as any).game;
      const actor = game.actors.get(actorId);
      const user = game.users.get(userId);
      return {
        actorVisible: actor.testUserPermission(user, 'OBSERVER'),
        itemIds: actor.items.filter((item: any) => item.testUserPermission(user, 'OBSERVER')).map((item: any) => item.id),
        ownership: actor.items.map((item: any) => ({ id: item.id, ownership: item.toObject().ownership })),
      };
    }, { actorId: actors[0], userId: a });
    // Foundry 14 embedded Items inherit the parent's native permission regardless
    // of their ownership field. The MCP contract also honors explicit item denies.
    expect(nativePermissions.actorVisible).toBe(true);
    expect(nativePermissions.itemIds.sort()).toEqual([visibleEmbedded, secondVisibleEmbedded, secretEmbedded].sort());
    expect(nativePermissions.ownership.find((item: any) => item.id === secretEmbedded)?.ownership)
      .toMatchObject({ default: 0, [b]: 2 });
    expect(response.records.map((item: any) => item.id).sort())
      .toEqual([visibleEmbedded, secondVisibleEmbedded].sort());
    expect(response.total).toBe(2);
    expect(JSON.stringify(response)).not.toContain(secretEmbedded);
    const detail = (await call('get_actor_item', { actorId: actors[0], itemId: secondVisibleEmbedded })).structuredContent as Record<string, any>;
    expect(detail.item).toMatchObject({ id: secondVisibleEmbedded, uuid: `Actor.${actors[0]}.Item.${secondVisibleEmbedded}` });
    expect(detail.item.fields.some((field: any) => field.path === 'system.quantity' && field.present && field.value === 0)).toBe(true);
    const hidden = await toolError('get_actor_item', { actorId: actors[0], itemId: secretEmbedded });
    expect(hidden).toEqual(await toolError('get_actor_item', { actorId: actors[0], itemId: 'zzzzzzzzzzzzzzzz' }));
    expect(hidden).toEqual(await toolError('get_actor_item', { actorId: actors[1], itemId: visibleEmbedded }));
    expect(hidden.message).not.toContain(secretEmbedded);
    token = 'b';
    expect(await toolError('list_actor_items', { actorId: actors[0] }))
      .toEqual(await toolError('list_actor_items', { actorId: 'zzzzzzzzzzzzzzzz' }));
    expect(await toolError('get_actor_item', { actorId: actors[0], itemId: secretEmbedded })).toEqual(hidden);
  });

  it('binds live owned-item continuation to caller, session, actor and embedded permissions', async () => {
    token = 'a';
    const first = (await call('list_actor_items', { actorId: actors[0], limit: 1 })).structuredContent as Record<string, any>;
    expect(first.nextCursor).toEqual(expect.any(String));
    const next = (await call('list_actor_items', { actorId: actors[0], limit: 1, cursor: first.nextCursor })).structuredContent as Record<string, any>;
    expect(next.snapshotId).toBe(first.snapshotId);
    expect(next.records[0].id).not.toBe(first.records[0].id);
    for (const args of [
      { actorId: actors[1], limit: 1 }, { actorId: actors[0], limit: 2 },
      { actorId: actors[0], limit: 1, query: 'Second' }, { actorId: actors[0], limit: 1, type: 'weapon' },
    ]) await expect(call('list_actor_items', { ...args, cursor: first.nextCursor })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    token = 'gm';
    await expect(call('list_actor_items', { actorId: actors[0], limit: 1, cursor: first.nextCursor })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    token = 'a';
    try {
      sessionId = 'changed-owned-item-session';
      await expect(call('list_actor_items', { actorId: actors[0], limit: 1, cursor: first.nextCursor })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    } finally { sessionId = 'live-caller-session'; }
    try {
      await update('Item', { _id: secondVisibleEmbedded, ownership: owner(b) }, `Actor.${actors[0]}`);
      await waitFor(async () => {
        const projected = (await call('list_actor_items', { actorId: actors[0] })).structuredContent as Record<string, any>;
        return projected.total === 1;
      });
      const absent = await toolError('get_actor_item', { actorId: actors[0], itemId: 'zzzzzzzzzzzzzzzz' });
      expect(await toolError('get_actor_item', { actorId: actors[0], itemId: secondVisibleEmbedded })).toEqual(absent);
      await expect(call('list_actor_items', { actorId: actors[0], limit: 1, cursor: first.nextCursor })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    } finally { await update('Item', { _id: secondVisibleEmbedded, ownership: { default: -1 } }, `Actor.${actors[0]}`); }
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

  it('binds journal summary and page-content cursors to caller, session, world, and format', async () => {
    token = 'a';
    const summary = (await call('get_journal', {
      journalId: journalShared,
      limit: 2,
    })).structuredContent as Record<string, any>;
    const content = (await call('get_journal_page', {
      journalId: journalShared,
      pageId: sharedLongPage,
      format: 'text',
      limit: 1,
    })).structuredContent as Record<string, any>;
    expect(summary.nextCursor).toEqual(expect.any(String));
    expect(content.nextCursor).toEqual(expect.any(String));

    token = 'b';
    await expect(call('get_journal', {
      journalId: journalShared,
      limit: 2,
      cursor: summary.nextCursor,
    })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(call('get_journal_page', {
      journalId: journalShared,
      pageId: sharedLongPage,
      format: 'text',
      limit: 1,
      cursor: content.nextCursor,
    })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });

    token = 'a';
    try {
      sessionId = 'new-journal-session';
      for (const [name, args] of [
        ['get_journal', { journalId: journalShared, limit: 2, cursor: summary.nextCursor }],
        ['get_journal_page', {
          journalId: journalShared,
          pageId: sharedLongPage,
          format: 'text',
          limit: 1,
          cursor: content.nextCursor,
        }],
      ] as const) {
        await expect(call(name, args)).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
      }
      sessionId = 'live-caller-session';
      await expect(call('get_journal_page', {
        journalId: journalShared,
        pageId: sharedLongPage,
        format: 'source',
        limit: 1,
        cursor: content.nextCursor,
      })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
      worldId = 'other-world';
      await expect(call('get_journal', {
        journalId: journalShared,
        limit: 2,
        cursor: summary.nextCursor,
      })).rejects.toMatchObject({ code: ErrorCode.InvalidRequest });
      await expect(call('get_journal_page', {
        journalId: journalShared,
        pageId: sharedLongPage,
        format: 'text',
        limit: 1,
        cursor: content.nextCursor,
      })).rejects.toMatchObject({ code: ErrorCode.InvalidRequest });
    } finally {
      sessionId = 'live-caller-session';
      worldId = 'test1world';
    }
  });

  it('honors immediate revocation and invalidates previously authorized cursors', async () => {
    token = 'a';
    const first = (await call('search_actors', { query: prefix, limit: 1 })).structuredContent!;
    const inventory = (await call('list_actor_items', { actorId: actors[0], limit: 1 })).structuredContent as Record<string, any>;
    try {
      await update('Actor', { _id: actors[0], ownership: { default: 0, [a]: 0 } });
      await waitFor(async () => !(await oracle('actors', [actors[0]], a)).length);
      const after = (await call('search_actors', { query: prefix })).structuredContent!;
      expect(after.total).toBe(2);
      expect(JSON.stringify(after)).not.toContain(actors[0]);
      await expect(call('get_actor_details', { actorId: actors[0] })).rejects.toMatchObject({ code: ErrorCode.InternalError });
      for (const [name, extra] of [
        ['get_actor_sheet', {}], ['get_actor_section', { section: 'attributes' }],
        ['list_actor_items', {}], ['get_actor_item', { itemId: visibleEmbedded }],
      ] as const) {
        expect(await toolError(name, { actorId: actors[0], ...extra }))
          .toEqual(await toolError(name, { actorId: 'zzzzzzzzzzzzzzzz', ...extra }));
      }
      const revokedInventory = await toolError('list_actor_items', { actorId: actors[0], limit: 1, cursor: inventory.nextCursor });
      expect(revokedInventory.code).toBe(ErrorCode.InternalError);
      expect(revokedInventory).toEqual(await toolError('list_actor_items', {
        actorId: 'zzzzzzzzzzzzzzzz', limit: 1, cursor: inventory.nextCursor,
      }));
      await expect(call('search_actors', { query: prefix, limit: 1, cursor: first.nextCursor })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    } finally { await update('Actor', { _id: actors[0], ownership: owner(a) }); }
  });

  it('applies immediate journal page and parent revocation to fresh reads and old cursors', async () => {
    token = 'a';
    const pageSummary = (await call('get_journal', {
      journalId: journalShared,
      limit: 2,
    })).structuredContent as Record<string, any>;
    const pageContent = (await call('get_journal_page', {
      journalId: journalShared,
      pageId: sharedLongPage,
      format: 'source',
      limit: 1,
    })).structuredContent as Record<string, any>;
    try {
      await update(
        'JournalEntryPage',
        { _id: sharedLongPage, ownership: owner(b) },
        `JournalEntry.${journalShared}`,
      );
      await waitFor(async () =>
        !(await journalPageOracle(journalShared, [sharedLongPage], a)).length,
      );
      await expect(call('get_journal', {
        journalId: journalShared,
        limit: 2,
        cursor: pageSummary.nextCursor,
      })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
      await expect(call('get_journal_page', {
        journalId: journalShared,
        pageId: sharedLongPage,
        format: 'source',
        limit: 1,
        cursor: pageContent.nextCursor,
      })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
      const afterPageRevocation = await collectJournalSummary(journalShared);
      expect(afterPageRevocation.records.map(page => page.id)).not.toContain(sharedLongPage);
      await expect(call('get_journal_page', {
        journalId: journalShared,
        pageId: sharedLongPage,
      })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    } finally {
      await update(
        'JournalEntryPage',
        { _id: sharedLongPage, ownership: { default: -1 } },
        `JournalEntry.${journalShared}`,
      );
      await waitFor(async () =>
        (await journalPageOracle(journalShared, [sharedLongPage], a)).length === 1,
      );
    }

    const parentSummary = (await call('get_journal', {
      journalId: journalShared,
      limit: 2,
    })).structuredContent as Record<string, any>;
    const parentContent = (await call('get_journal_page', {
      journalId: journalShared,
      pageId: sharedLongPage,
      format: 'source',
      limit: 1,
    })).structuredContent as Record<string, any>;
    try {
      await update('JournalEntry', { _id: journalShared, ownership: owner(b) });
      await waitFor(async () => !(await oracle('journal', [journalShared], a)).length);
      for (const [name, args] of [
        ['get_journal', {
          journalId: journalShared,
          limit: 2,
          cursor: parentSummary.nextCursor,
        }],
        ['get_journal_page', {
          journalId: journalShared,
          pageId: sharedLongPage,
          format: 'source',
          limit: 1,
          cursor: parentContent.nextCursor,
        }],
      ] as const) {
        await expect(call(name, args)).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
      }
      await expect(call('get_journal', { journalId: journalShared })).rejects.toMatchObject({
        code: ErrorCode.InvalidParams,
      });
      await expect(call('get_journal_page', {
        journalId: journalShared,
        pageId: sharedLongPage,
      })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    } finally {
      await update('JournalEntry', { _id: journalShared, ownership: { default: 2 } });
      await waitFor(async () => (await oracle('journal', [journalShared], a)).length === 1);
    }
  });

  it('invalidates journal cursors after live edits, reordering, and deletion', async () => {
    token = 'a';
    const originalSummary = (await call('get_journal', {
      journalId: journalShared,
      limit: 2,
    })).structuredContent as Record<string, any>;
    const originalContent = (await call('get_journal_page', {
      journalId: journalShared,
      pageId: sharedLongPage,
      format: 'source',
      limit: 1,
    })).structuredContent as Record<string, any>;
    try {
      await update(
        'JournalEntryPage',
        { _id: sharedLongPage, sort: 50_000, text: { format: 2, markdown: editedLongJournalText } },
        `JournalEntry.${journalShared}`,
      );
      await waitFor(async () => pages.get(gm)!.evaluate(({ journalId, pageId, content }) => {
        const page = (globalThis as any).game.journal.get(journalId)?.pages.get(pageId);
        return page?.sort === 50_000 && page?.text?.markdown === content;
      }, { journalId: journalShared, pageId: sharedLongPage, content: editedLongJournalText }));
      await expect(call('get_journal', {
        journalId: journalShared,
        limit: 2,
        cursor: originalSummary.nextCursor,
      })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
      await expect(call('get_journal_page', {
        journalId: journalShared,
        pageId: sharedLongPage,
        format: 'source',
        limit: 1,
        cursor: originalContent.nextCursor,
      })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
      const reordered = (await call('get_journal', {
        journalId: journalShared,
        limit: 2,
      })).structuredContent as Record<string, any>;
      expect(reordered.pages[0].id).toBe(sharedLongPage);
      expect((await collectJournalPage(journalShared, sharedLongPage, 'source', 1)).content)
        .toBe(editedLongJournalText);
    } finally {
      await update(
        'JournalEntryPage',
        { _id: sharedLongPage, sort: 300_000, text: { format: 2, markdown: longJournalText } },
        `JournalEntry.${journalShared}`,
      );
      await waitFor(async () => pages.get(gm)!.evaluate(({ journalId, pageId, content }) => {
        const page = (globalThis as any).game.journal.get(journalId)?.pages.get(pageId);
        return page?.sort === 300_000 && page?.text?.markdown === content;
      }, { journalId: journalShared, pageId: sharedLongPage, content: longJournalText }));
    }

    const ephemeralContent = `${prefix} ephemeral page\n${'ephemeral-content-'.repeat(300)}`;
    const ephemeralPage = (await create('JournalEntryPage', {
      name: `${prefix} Ephemeral Page`,
      type: 'text',
      sort: 1_200_000,
      ownership: { default: -1 },
      text: { format: 2, markdown: ephemeralContent },
    }, `JournalEntry.${journalShared}`))._id;
    let deleted = false;
    try {
      await waitFor(async () =>
        (await journalPageOracle(journalShared, [ephemeralPage], a)).length === 1,
      );
      const beforeDeletionSummary = (await call('get_journal', {
        journalId: journalShared,
        limit: 2,
      })).structuredContent as Record<string, any>;
      const beforeDeletionContent = (await call('get_journal_page', {
        journalId: journalShared,
        pageId: ephemeralPage,
        format: 'source',
        limit: 1,
      })).structuredContent as Record<string, any>;
      expect(beforeDeletionSummary.nextCursor).toEqual(expect.any(String));
      expect(beforeDeletionContent.nextCursor).toEqual(expect.any(String));
      await fixtureWriter().modifyDocument('JournalEntryPage', 'delete', {
        ids: [ephemeralPage],
        parentUuid: `JournalEntry.${journalShared}`,
      });
      deleted = true;
      await waitFor(async () =>
        !(await journalPageOracle(journalShared, [ephemeralPage], a)).length,
      );
      await expect(call('get_journal', {
        journalId: journalShared,
        limit: 2,
        cursor: beforeDeletionSummary.nextCursor,
      })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
      await expect(call('get_journal_page', {
        journalId: journalShared,
        pageId: ephemeralPage,
        format: 'source',
        limit: 1,
        cursor: beforeDeletionContent.nextCursor,
      })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
      await expect(call('get_journal_page', {
        journalId: journalShared,
        pageId: ephemeralPage,
      })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    } finally {
      if (!deleted) {
        await fixtureWriter().modifyDocument('JournalEntryPage', 'delete', {
          ids: [ephemeralPage],
          parentUuid: `JournalEntry.${journalShared}`,
        });
      }
    }
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
      for (const args of [{ formula: '1d6', engine: 'foundry' }, { formula: null, engine: 'invalid' }]) {
        await expect(call('roll_dice', args)).rejects.toMatchObject({ code: ErrorCode.InvalidRequest });
      }
      await expect(resource('foundry://world/settings')).rejects.toMatchObject({ code: ErrorCode.InvalidRequest });
    }
  });

  it('fails closed on backend disconnect, then resumes fresh reads after reconnect', async () => {
    token = 'a';
    const first = (await call('search_actors', { query: prefix, limit: 1 })).structuredContent!;
    const journalSummary = (await call('get_journal', {
      journalId: journalShared,
      limit: 2,
    })).structuredContent as Record<string, any>;
    const journalContent = (await call('get_journal_page', {
      journalId: journalShared,
      pageId: sharedLongPage,
      format: 'source',
      limit: 1,
    })).structuredContent as Record<string, any>;
    await backend!.disconnect();
    await expect(call('search_actors', { query: prefix })).rejects.toMatchObject({ code: ErrorCode.InvalidRequest });
    await expect(resource('foundry://actors')).rejects.toMatchObject({ code: ErrorCode.InvalidRequest });
    await expect(call('get_journal', { journalId: journalShared })).rejects.toMatchObject({
      code: ErrorCode.InvalidRequest,
    });
    await expect(call('get_journal_page', {
      journalId: journalShared,
      pageId: sharedLongPage,
    })).rejects.toMatchObject({ code: ErrorCode.InvalidRequest });
    await backend!.connect();
    expect((await call('search_actors', { query: prefix })).structuredContent!.total).toBe(3);
    expect((await call('get_journal', {
      journalId: journalShared,
      limit: 2,
    })).structuredContent!.pages).toHaveLength(2);
    await expect(call('search_actors', { query: prefix, limit: 1, cursor: first.nextCursor })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(call('get_journal', {
      journalId: journalShared,
      limit: 2,
      cursor: journalSummary.nextCursor,
    })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(call('get_journal_page', {
      journalId: journalShared,
      pageId: sharedLongPage,
      format: 'source',
      limit: 1,
      cursor: journalContent.nextCursor,
    })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
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
