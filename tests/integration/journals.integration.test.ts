/** Complete journal reads through the built MCP stdio server and real Foundry documents. */
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
import { journalPageContentSchema, journalSummarySchema } from '../../src/foundry/journal-contract.js';
import { type WorldReadMetadata, worldReadMetadataSchema } from '../../src/foundry/freshness.js';

const seedSchema = z.object({
  id: z.string(), emptyId: z.string(), pages: z.array(z.object({
    _id: z.string(), name: z.string(), type: z.string(), sort: z.number(),
    text: z.object({ content: z.string().nullable().optional(), markdown: z.string().nullable().optional(), format: z.number() }).optional(),
    src: z.string().nullable().optional(),
    image: z.object({ caption: z.string().nullable().optional() }).optional(),
    expectedText: z.string(),
  })),
});
type Seed = z.infer<typeof seedSchema>;
type Summary = z.infer<typeof journalSummarySchema>;

describe('live complete journal reads through built MCP stdio', () => {
  let controlUrl: string;
  let cwd: string;
  let seed: Seed;
  let client: Client;
  let other: Client;
  const clients: Client[] = [];
  const transports: StdioClientTransport[] = [];
  const schemas = new Map<string, object>();
  const ajv = new Ajv({ allErrors: true, strict: false });

  async function control(path: string, method = 'POST'): Promise<unknown> {
    const response = await fetch(controlUrl + path, { method, signal: AbortSignal.timeout(90_000) });
    if (!response.ok) throw new Error(`Journal test-world control failed (${response.status})`);
    return response.json();
  }
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
    const connected = new Client({ name: 'live-journal-integration', version: '1.0.0' });
    clients.push(connected);
    await connected.connect(transport);
    for (const tool of (await connected.listTools()).tools) if (tool.outputSchema) schemas.set(tool.name, tool.outputSchema);
    return connected;
  }
  beforeAll(async () => {
    controlUrl = process.env.FOUNDRY_JOURNAL_TEST_CONTROL_URL ?? '';
    if (!controlUrl || !process.env.FOUNDRY_URL || !process.env.FOUNDRY_USERNAME) {
      throw new Error('Live journal tests require an explicit disposable-world controller and Foundry credentials');
    }
    const status = z.object({ world: z.literal('test1world'), version: z.string(), system: z.string(), systemVersion: z.string() })
      .parse(await control('/status', 'GET'));
    console.info('Live journal integration versions', JSON.stringify(status));
    seed = seedSchema.parse(await control('/seed'));
    cwd = await mkdtemp(join(tmpdir(), 'foundry-live-journals-'));
    client = await connect();
    other = await connect();
  });
  afterAll(async () => {
    await Promise.allSettled([...clients.map(c => c.close()), ...transports.map(t => t.close())]);
    try { if (controlUrl) await control('/cleanup'); }
    finally { if (cwd) await rm(cwd, { recursive: true, force: true }); }
  });
  async function call(name: string, args: Record<string, unknown>, connected = client) {
    const result = CallToolResultSchema.parse(await connected.callTool({ name, arguments: args }));
    const schema = schemas.get(name);
    expect(schema).toBeDefined();
    expect(ajv.validate(schema!, result.structuredContent), JSON.stringify(ajv.errors)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(128 * 1024);
    const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
    const { readMetadata } = z.object({ readMetadata: worldReadMetadataSchema }).parse(result.structuredContent);
    expect(text).toContain(`**Freshness:** ${readMetadata.freshness}`);
    expect(readMetadata.freshness).not.toBe('unavailable');
    if (args.cursor === undefined) expect(readMetadata.freshness).toBe('current');
    return { data: result.structuredContent, text };
  }
  function expectCapturedMetadata(actual: WorldReadMetadata, captured: WorldReadMetadata) {
    const { freshness: _actualFreshness, respondedAt: _actualResponse, ...actualSource } = actual;
    const { freshness: _capturedFreshness, respondedAt: _capturedResponse, ...capturedSource } = captured;
    expect(actualSource).toEqual(capturedSource);
  }
  async function summary(args: Record<string, unknown> = {}) {
    const { data, text } = await call('get_journal', { journalId: seed.id, ...args });
    const page = journalSummarySchema.parse(data);
    expect(text).toContain(page.id); expect(text).toContain(page.uuid);
    expect(text).toContain(`**Returned:** ${page.returnedCount}/${page.total}`);
    for (const entry of page.pages) {
      expect(text).toContain(entry.id); expect(text).toContain(entry.uuid);
      expect(text).toContain(`Preview truncated: ${entry.contentTruncated}`);
      if (entry.content) expect(text).toContain(entry.content);
    }
    return page;
  }
  async function allSummaries(limit = 4) {
    const first = await summary({ limit });
    let page = first;
    const pages = [...page.pages];
    while (page.nextCursor) {
      const previous = page;
      page = await summary({ limit, cursor: page.nextCursor });
      expect(page.page).toBe(previous.page + 1);
      expect(page.snapshotId).toBe(first.snapshotId);
      expectCapturedMetadata(page.readMetadata, first.readMetadata);
      expect(page.total).toBe(first.total);
      pages.push(...page.pages);
    }
    expect(page.complete).toBe(true); expect(page.nextCursor).toBeNull();
    expect(new Set(pages.map(entry => entry.id)).size).toBe(first.total);
    return pages;
  }
  async function content(pageId: string, format: 'text' | 'source', args: Record<string, unknown> = {}) {
    const { data, text } = await call('get_journal_page', { journalId: seed.id, pageId, format, ...args });
    const page = journalPageContentSchema.parse(data);
    expect(text).toContain(page.page.id); expect(text).toContain(page.page.uuid);
    expect(text).toContain(`**Content length:** ${page.contentLength} Unicode code points`);
    expect(text).toContain(`**Content truncated:** ${page.contentTruncated}`);
    for (const chunk of page.chunks) expect(text).toContain(chunk.content);
    return page;
  }
  function fixture(name: string) {
    const page = seed.pages.find(entry => entry.name === name);
    if (!page) throw new Error(`Missing seeded journal page ${name}`);
    return page;
  }

  it.each([1, 4, 8])('traverses actual page IDs, UUIDs, names and order with limit %i', async limit => {
    const pages = await allSummaries(limit);
    expect(pages.map(page => page.id)).toEqual(seed.pages.toSorted((a, b) => a.sort - b.sort).map(page => page._id));
    for (const page of pages) {
      const expected = seed.pages.find(entry => entry._id === page.id)!;
      expect(page).toMatchObject({
        uuid: `JournalEntry.${seed.id}.JournalEntryPage.${expected._id}`,
        name: expected.name, type: expected.type, sort: expected.sort,
        sourceFormat: expected.type !== 'text' ? 'none' : expected.text?.format === 2 ? 'markdown' : 'html',
      });
    }
  });
  it.each([0, 499, 500, 501])('reports exact previews at the %i Unicode code point boundary', async length => {
    const expected = fixture(length === 0 ? 'Empty' : `Boundary ${length}`);
    const page = (await allSummaries()).find(entry => entry.id === expected._id)!;
    expect(Array.from(page.content)).toHaveLength(Math.min(500, length));
    expect(page.content).toBe(Array.from(expected.expectedText).slice(0, 500).join(''));
    expect(page.contentTruncated).toBe(length > 500);
  });
  it.each([
    'Empty', 'Boundary 499', 'Boundary 500', 'Boundary 501', 'Long HTML', 'Entities',
    'Markdown', 'Image', 'Video', 'Ordered 9', 'Ordered 10', 'Ordered 11',
  ].flatMap(name => (['text', 'source'] as const).map(format => ({ name, format }))))(
    'reconstructs the complete $format content of $name from bounded chunks', async ({ name, format }) => {
      const expected = fixture(name);
      const exact = expected.type !== 'text' ? '' : format === 'text' ? expected.expectedText : (expected.text?.format === 2 ? expected.text.markdown : expected.text?.content) ?? '';
      const points = Array.from(exact);
      let page = await content(expected._id, format, { limit: 2 });
      const snapshot = page.snapshotId;
      const capturedMetadata = page.readMetadata;
      let received = '';
      let index = 0;
      let start = 0;
      let paginationPage = 0;
      do {
        expect(page.paginationPage).toBe(++paginationPage);
        expect(page.snapshotId).toBe(snapshot);
        expectCapturedMetadata(page.readMetadata, capturedMetadata);
        expect(page.contentLength).toBe(points.length);
        expect(page.contentTruncated).toBe(!page.complete);
        expect(page.chunks.length).toBeLessThanOrEqual(2);
        for (const chunk of page.chunks) {
          expect(chunk.index).toBe(index++); expect(chunk.start).toBe(start);
          expect(Array.from(chunk.content)).toHaveLength(chunk.end - chunk.start);
          expect(Array.from(chunk.content).length).toBeLessThanOrEqual(1024);
          expect(chunk.content).toBe(points.slice(chunk.start, chunk.end).join(''));
          start = chunk.end; received += chunk.content;
        }
        if (!page.nextCursor) break;
        page = await content(expected._id, format, { limit: 2, cursor: page.nextCursor });
      } while (true);
      expect(page.complete).toBe(true); expect(page.nextCursor).toBeNull();
      expect(start).toBe(points.length); expect(received).toBe(exact);
      expect(index).toBe(expected.type !== 'text' ? 0 : Math.max(1, Math.ceil(points.length / 1024)));
      if (name === 'Long HTML') expect(page.contentLength).toBeGreaterThan(10_000);
    },
  );
  it('exposes image/video asset metadata without inventing text chunks', async () => {
    for (const name of ['Image', 'Video']) {
      const expected = fixture(name);
      const page = await content(expected._id, 'text');
      expect(page).toMatchObject({ contentLength: 0, total: 0, chunks: [], complete: true, contentTruncated: false });
      expect(page.page.asset?.src).toBe(expected.src);
      if (name === 'Image') expect(page.page.asset?.caption).toBe('Fixture image caption');
    }
  });
  it('returns explicit complete zero pages for an empty journal', async () => {
    const { data, text } = await call('get_journal', { journalId: seed.emptyId });
    expect(journalSummarySchema.parse(data)).toMatchObject({ total: 0, returnedCount: 0, pages: [], complete: true, nextCursor: null });
    expect(text).toContain('No pages.');
  });
  it.each([
    { journalId: 'bad' }, { journalId: 'AAAAAAAAAAAAAAAA' }, { journalId: 'JournalEntry.AAAAAAAAAAAAAAAA' },
    { limit: 0 }, { limit: 9 }, { limit: 1.5 }, { cursor: '' }, { unexpected: true },
  ])('rejects invalid, absent or unsupported summary input %j', async args => {
    await expect(client.callTool({ name: 'get_journal', arguments: { journalId: seed.id, ...args } }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });
  it.each([
    { pageId: 'bad' }, { pageId: 'AAAAAAAAAAAAAAAA' }, { journalId: 'AAAAAAAAAAAAAAAA' },
    { format: 'html' }, { limit: 0 }, { limit: 9 }, { limit: 1.5 }, { cursor: '' }, { unexpected: true },
  ])('rejects invalid, absent or unsupported page input %j', async args => {
    await expect(client.callTool({ name: 'get_journal_page', arguments: { journalId: seed.id, pageId: fixture('Long HTML')._id, ...args } }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });
  it('binds continuations to the tool, journal, page, format, limit and server session', async () => {
    const first = await summary({ limit: 1 });
    const long = await content(fixture('Long HTML')._id, 'text', { limit: 1 });
    expect(first.nextCursor).toBeTruthy(); expect(long.nextCursor).toBeTruthy();
    for (const [connected, name, args] of [
      [client, 'get_journal', { journalId: seed.id, limit: 2, cursor: first.nextCursor }],
      [client, 'get_journal', { journalId: seed.emptyId, limit: 1, cursor: first.nextCursor }],
      [other, 'get_journal', { journalId: seed.id, limit: 1, cursor: first.nextCursor }],
      [client, 'get_journal_page', { journalId: seed.id, pageId: fixture('Long HTML')._id, format: 'text', limit: 1, cursor: first.nextCursor }],
      [client, 'get_journal_page', { journalId: seed.id, pageId: fixture('Long HTML')._id, format: 'source', limit: 1, cursor: long.nextCursor }],
      [client, 'get_journal_page', { journalId: seed.id, pageId: fixture('Long HTML')._id, format: 'text', limit: 2, cursor: long.nextCursor }],
      [client, 'get_journal_page', { journalId: seed.id, pageId: fixture('Entities')._id, format: 'text', limit: 1, cursor: long.nextCursor }],
      [other, 'get_journal_page', { journalId: seed.id, pageId: fixture('Long HTML')._id, format: 'text', limit: 1, cursor: long.nextCursor }],
      [client, 'get_journal', { journalId: seed.id, limit: 1, cursor: long.nextCursor }],
    ] as const) {
      await expect(connected.callTool({ name, arguments: args })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    }
    expect((await content(fixture('Long HTML')._id, 'text', { limit: 1, cursor: long.nextCursor })).paginationPage).toBe(2);
    expect((await summary({ limit: 1, cursor: first.nextCursor })).page).toBe(2);
  });
  it.each(['edit', 'sort', 'delete'])('invalidates both cursor families after a real page %s', async kind => {
    seed = seedSchema.parse(await control('/seed'));
    const target = fixture(kind === 'edit' ? 'Long HTML' : 'Ordered 9');
    const first = await summary({ limit: 1 });
    const long = await content(fixture('Long HTML')._id, 'text', { limit: 1 });
    await control(`/mutate?kind=${kind}&journalId=${seed.id}&pageId=${target._id}`);
    await expect.poll(async () => {
      try { await client.callTool({ name: 'get_journal', arguments: { journalId: seed.id, limit: 1, cursor: first.nextCursor } }); return false; }
      catch (error) { return (error as { code: number }).code === ErrorCode.InvalidParams; }
    }, { timeout: 10_000 }).toBe(true);
    await expect(client.callTool({ name: 'get_journal_page', arguments: {
      journalId: seed.id, pageId: fixture('Long HTML')._id, format: 'text', limit: 1, cursor: long.nextCursor,
    } })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    if (kind === 'edit') {
      const page = await content(target._id, 'text');
      expect(page.chunks.map(chunk => chunk.content).join('')).toBe('Edited fixture 😀');
    } else if (kind === 'sort') {
      const pages = await allSummaries();
      expect(pages.at(-1)?.id).toBe(target._id);
    } else {
      expect((await allSummaries()).map(page => page.id)).not.toContain(target._id);
      await expect(client.callTool({ name: 'get_journal_page', arguments: { journalId: seed.id, pageId: target._id } }))
        .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    }
  });
});
