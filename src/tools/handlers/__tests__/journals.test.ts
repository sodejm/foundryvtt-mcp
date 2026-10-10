/**
 * @fileoverview Unit tests for journals handlers — search_journals and get_journal
 */

import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import Ajv from 'ajv';
import { describe, expect, it, vi } from 'vitest';
import type { FoundryClient } from '../../../foundry/client.js';
import { JournalReadUnavailableError } from '../../../foundry/journal-read.js';
import { PaginationCursorError } from '../../../foundry/pagination.js';
import { getAllTools } from '../../definitions.js';
import { handleGetJournal, handleGetJournalPage, handleSearchJournals } from '../journals.js';
import { paginationMetadata, readMetadata } from './pagination-fixture.js';

function getText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0]?.text ?? '';
}

describe('handleSearchJournals', () => {
  it('returns metadata, stable IDs and a bounded page', async () => {
    const records = [
      { id: 'Journal000000001', name: 'Adventure Log', documentType: 'JournalEntry', pageCount: 5 },
    ];
    const searchJournalsPage = vi.fn().mockResolvedValue({ records, ...paginationMetadata(1) });
    const result = await handleSearchJournals({ query: 'adventure' }, {
      searchJournalsPage,
    } as unknown as FoundryClient);
    expect(result.structuredContent).toMatchObject({
      schemaVersion: 3,
      scope: 'journals',
      records,
      total: 1,
      complete: true,
    });
    expect(getText(result)).toContain('ID: Journal000000001');
    expect(getText(result)).toContain('**Returned:** 1/1');
    expect(searchJournalsPage).toHaveBeenCalledWith({ query: 'adventure' });
  });
  it('forwards limit and cursor and reports continuation', async () => {
    const searchJournalsPage = vi
      .fn()
      .mockResolvedValue({ records: [], ...paginationMetadata(0, 25, 5) });
    const result = await handleSearchJournals({ limit: 5, cursor: 'fixture-cursor' }, {
      searchJournalsPage,
    } as unknown as FoundryClient);
    expect(searchJournalsPage).toHaveBeenCalledWith({ limit: 5, cursor: 'fixture-cursor' });
    expect(result.structuredContent).toMatchObject({
      total: 25,
      complete: false,
      nextCursor: 'fixture-cursor',
    });
    expect(getText(result)).toContain('**Next cursor:** fixture-cursor');
  });
  it('returns an explicit complete empty page', async () => {
    const result = await handleSearchJournals({}, {
      searchJournalsPage: vi.fn().mockResolvedValue({ records: [], ...paginationMetadata(0) }),
    } as unknown as FoundryClient);
    expect(getText(result)).toContain('No results found.');
    expect(result.structuredContent.complete).toBe(true);
  });
  it('wraps backend errors', async () => {
    await expect(
      handleSearchJournals({}, {
        searchJournalsPage: vi.fn().mockRejectedValue(new Error('offline')),
      } as unknown as FoundryClient),
    ).rejects.toThrow('offline');
  });
});

const journalId = 'Journal000000001';
const pageId = 'Page000000000001';
const metadata = {
  id: pageId,
  uuid: `JournalEntry.${journalId}.JournalEntryPage.${pageId}`,
  name: 'Introduction',
  type: 'text',
  sort: 10,
  sourceFormat: 'html',
};
const summary = (pages = [{ ...metadata, content: 'Hello world.', contentTruncated: false }]) => ({
  id: journalId,
  uuid: `JournalEntry.${journalId}`,
  name: 'Test Journal',
  pages,
  ...paginationMetadata(pages.length, pages.length, 4),
});
function pageContent(overrides: Record<string, unknown> = {}) {
  const { page, ...pagination } = paginationMetadata(1, 1, 4);
  return {
    journalId,
    page: metadata,
    format: 'text',
    contentLength: 12,
    chunks: [{ index: 0, start: 0, end: 12, content: 'Hello world.' }],
    contentTruncated: false,
    ...pagination,
    paginationPage: page,
    ...overrides,
  };
}
const client = (method: string, fn: unknown, delegated = false) =>
  ({
    [method]: fn,
    isDelegatedMode: () => delegated,
  }) as unknown as FoundryClient;
function validate(tool: string, value: unknown) {
  const schema = getAllTools().find((entry) => entry.name === tool)?.outputSchema;
  expect(schema).toBeDefined();
  const ajv = new Ajv({ strict: false, validateFormats: false });
  expect(ajv.validate(schema as object, value), JSON.stringify(ajv.errors)).toBe(true);
}

describe('bounded journal handlers', () => {
  it('returns summary page IDs, source format, freshness and an explicit preview flag', async () => {
    const fn = vi.fn().mockResolvedValue(summary());
    const result = await handleGetJournal({ journalId }, client('getJournalSummaryPage', fn));
    expect(fn).toHaveBeenCalledWith({ journalId });
    expect(result.structuredContent).toMatchObject({
      schemaVersion: 3,
      documentType: 'JournalEntry',
      pages: [metadata],
    });
    const text = getText(result);
    for (const value of [
      journalId,
      pageId,
      metadata.uuid,
      metadata.name,
      'Hello world.',
      'Preview truncated: false',
      '**Freshness:** current',
    ]) {
      expect(text).toContain(value);
    }
    validate('get_journal', result.structuredContent);
  });
  it('preserves bounded continuation and marks a truncated preview', async () => {
    const data = {
      ...summary([{ ...metadata, content: '😀'.repeat(500), contentTruncated: true }]),
      ...paginationMetadata(1, 9, 1),
    };
    const fn = vi.fn().mockResolvedValue(data);
    const result = await handleGetJournal(
      { journalId, limit: 1, cursor: 'fixture-cursor' },
      client('getJournalSummaryPage', fn),
    );
    expect(fn).toHaveBeenCalledWith({ journalId, limit: 1, cursor: 'fixture-cursor' });
    expect(getText(result)).toContain(`${'😀'.repeat(500)}...`);
    expect(getText(result)).toContain('**Next cursor:** fixture-cursor');
    expect(result.structuredContent.complete).toBe(false);
    validate('get_journal', result.structuredContent);
  });
  it('reports an empty journal without manufacturing content', async () => {
    const result = await handleGetJournal(
      { journalId },
      client('getJournalSummaryPage', vi.fn().mockResolvedValue(summary([]))),
    );
    expect(getText(result)).toContain('No pages.');
    expect(result.structuredContent).toMatchObject({
      total: 0,
      returnedCount: 0,
      complete: true,
      nextCursor: null,
    });
  });
  it.each([
    'text',
    'source',
  ])('returns exact %s chunks and numeric pagination separately from page metadata', async (format) => {
    const content = '## Exact source\n😀 & <p>text</p>';
    const fn = vi.fn().mockResolvedValue(
      pageContent({
        format,
        contentLength: Array.from(content).length,
        chunks: [{ index: 3, start: 3072, end: 3072 + Array.from(content).length, content }],
        paginationPage: 4,
        readMetadata: readMetadata({ freshness: 'stale' }),
      }),
    );
    const result = await handleGetJournalPage(
      { journalId, pageId, format, limit: 4, cursor: 'fixture-cursor' },
      client('getJournalPageContent', fn),
    );
    expect(fn).toHaveBeenCalledWith({
      journalId,
      pageId,
      format,
      limit: 4,
      cursor: 'fixture-cursor',
    });
    expect(result.structuredContent.page).toEqual(metadata);
    expect(result.structuredContent.paginationPage).toBe(4);
    for (const value of [content, metadata.uuid, `Format: ${format}`, '**Freshness:** stale']) {
      expect(getText(result)).toContain(value);
    }
    validate('get_journal_page', result.structuredContent);
  });
  it('returns non-text asset metadata with no invented text chunks', async () => {
    const data = pageContent({
      page: {
        ...metadata,
        type: 'image',
        sourceFormat: 'none',
        asset: { src: 'worlds/test1world/image.webp', caption: 'A map' },
      },
      contentLength: 0,
      chunks: [],
      total: 0,
      returnedCount: 0,
    });
    const result = await handleGetJournalPage(
      { journalId, pageId },
      client('getJournalPageContent', vi.fn().mockResolvedValue(data)),
    );
    expect(getText(result)).toContain('No text content.');
    expect(result.structuredContent.page.asset).toEqual(data.page.asset);
    validate('get_journal_page', result.structuredContent);
  });
  const invalid = [
    {},
    { journalId: 'bad' },
    { journalId: `${journalId}x` },
    { journalId: `JournalEntry.${journalId}` },
    { journalId, extra: true },
    ...[0, 9, 1.5, '4', null].map((limit) => ({ journalId, limit })),
    ...['', 1, null, 'x'.repeat(1025)].map((cursor) => ({ journalId, cursor })),
  ];
  it.each(invalid)('rejects invalid summary parameters before backend access: %j', async (args) => {
    const fn = vi.fn();
    await expect(handleGetJournal(args, client('getJournalSummaryPage', fn))).rejects.toMatchObject(
      { code: ErrorCode.InvalidParams },
    );
    expect(fn).not.toHaveBeenCalled();
  });
  it.each([
    ...invalid.map((args) => ({ pageId, ...args })),
    { journalId },
    { journalId, pageId: 'bad' },
    { journalId, pageId, format: 'HTML' },
    { journalId, pageId, format: null },
  ])('rejects invalid page parameters before backend access: %j', async (args) => {
    const fn = vi.fn();
    await expect(
      handleGetJournalPage(args, client('getJournalPageContent', fn)),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    expect(fn).not.toHaveBeenCalled();
  });
  it.each([
    ['summary', handleGetJournal, 'getJournalSummaryPage', { journalId }],
    ['page', handleGetJournalPage, 'getJournalPageContent', { journalId, pageId }],
  ] as const)('maps missing/denied %s and invalid cursors to InvalidParams', async (_name, handler, method, args) => {
    await expect(
      handler(args, client(method, vi.fn().mockRejectedValue(new JournalReadUnavailableError()))),
    ).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
      message: expect.stringContaining('Journal unavailable'),
    });
    await expect(
      handler(
        args,
        client(method, vi.fn().mockRejectedValue(new PaginationCursorError('expired'))),
      ),
    ).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
      message: expect.stringContaining('expired'),
    });
    await expect(
      handler(
        args,
        client(method, vi.fn().mockRejectedValue(new PaginationCursorError('secret owner')), true),
      ),
    ).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
      message: expect.stringContaining('Pagination cursor unavailable'),
    });
  });
  it.each([
    [handleGetJournal, 'getJournalSummaryPage', { journalId }],
    [handleGetJournalPage, 'getJournalPageContent', { journalId, pageId }],
  ] as const)('rejects malformed backend output and sanitizes delegated backend failures', async (handler, method, args) => {
    await expect(
      handler(args, client(method, vi.fn().mockResolvedValue({}))),
    ).rejects.toMatchObject({ code: ErrorCode.InternalError });
    const result = handler(
      args,
      client(method, vi.fn().mockRejectedValue(new Error('private backend detail')), true),
    );
    await expect(result).rejects.toMatchObject({
      code: ErrorCode.InternalError,
      message: expect.stringContaining('Delegated read unavailable'),
    });
    await expect(result).rejects.not.toThrow('private backend detail');
  });
  it('enforces the combined wire cap even when individual page metadata is valid', async () => {
    const pages = Array.from({ length: 8 }, (_, index) => ({
      ...metadata,
      id: `Page00000000000${index}`,
      uuid: `JournalEntry.${journalId}.JournalEntryPage.Page00000000000${index}`,
      asset: { src: 's'.repeat(16000), caption: 'c'.repeat(8000) },
      content: '',
      contentTruncated: false,
    }));
    await expect(
      handleGetJournal(
        { journalId, limit: 8 },
        client(
          'getJournalSummaryPage',
          vi.fn().mockResolvedValue({ ...summary(pages), ...paginationMetadata(8, 8, 8) }),
        ),
      ),
    ).rejects.toThrow('smaller limit');
  });
});
