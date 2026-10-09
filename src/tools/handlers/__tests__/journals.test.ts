/**
 * @fileoverview Unit tests for journals handlers — search_journals and get_journal
 */

import { describe, expect, it, vi } from 'vitest';
import type { FoundryClient } from '../../../foundry/client.js';
import { handleGetJournal, handleSearchJournals } from '../journals.js';
import { paginationMetadata } from './pagination-fixture.js';

interface MockJournal {
  _id: string;
  name: string;
  pages?: Array<{
    _id: string;
    name: string;
    type: string;
    text?: { content: string; format: number };
  }>;
}

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
      schemaVersion: 2,
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

describe('handleGetJournal', () => {
  describe('happy path', () => {
    it('returns journal with HTML-stripped page content', async () => {
      const journal: MockJournal = {
        _id: 'jrnl-1',
        name: 'Test Journal',
        pages: [
          {
            _id: 'p-1',
            name: 'Introduction',
            type: 'text',
            text: { content: '<p>Hello <b>world</b>.</p>', format: 1 },
          },
        ],
      };
      const client = {
        getJournal: vi.fn((_id: string) => journal),
      } as unknown as FoundryClient;

      const result = await handleGetJournal({ journalId: 'jrnl-1' }, client);
      const text = getText(result);

      expect(text).toContain('**Journal: Test Journal**');
      expect(text).toContain('ID: jrnl-1');
      expect(text).toContain('### Introduction');
      expect(text).toContain('Hello world.');
      // HTML tags should have been stripped
      expect(text).not.toContain('<p>');
      expect(text).not.toContain('<b>');
      expect(client.getJournal).toHaveBeenCalledWith('jrnl-1');
    });

    it('falls back to "No pages." when journal has no pages', async () => {
      const journal: MockJournal = { _id: 'jrnl-2', name: 'Empty', pages: [] };
      const client = {
        getJournal: vi.fn(() => journal),
      } as unknown as FoundryClient;

      const result = await handleGetJournal({ journalId: 'jrnl-2' }, client);
      const text = getText(result);

      expect(text).toContain('**Journal: Empty**');
      expect(text).toContain('No pages.');
    });
  });

  describe('edge cases', () => {
    it('throws McpError when journal not found', async () => {
      const client = {
        getJournal: vi.fn(() => undefined),
      } as unknown as FoundryClient;

      await expect(handleGetJournal({ journalId: 'missing' }, client)).rejects.toThrow(
        /Journal not found: missing/,
      );
    });

    it('truncates page content longer than 500 chars with ellipsis', async () => {
      const longText = 'a'.repeat(600);
      const journal: MockJournal = {
        _id: 'jrnl-3',
        name: 'Long',
        pages: [
          {
            _id: 'p-1',
            name: 'Big Page',
            type: 'text',
            text: { content: longText, format: 1 },
          },
        ],
      };
      const client = {
        getJournal: vi.fn(() => journal),
      } as unknown as FoundryClient;

      const result = await handleGetJournal({ journalId: 'jrnl-3' }, client);
      const text = getText(result);

      expect(text).toContain('### Big Page');
      expect(text).toContain('...');
      // The 500-char slice should be present but the full 600-char string should not
      expect(text).not.toContain('a'.repeat(600));
    });
  });
});
