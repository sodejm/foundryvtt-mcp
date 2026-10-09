import { describe, expect, it } from 'vitest';
import {
  htmlToJournalText,
  JOURNAL_CONTENT_CHUNK_CODEPOINTS,
  JOURNAL_MAX_HTML_NODES,
  JOURNAL_MAX_SOURCE_BYTES,
  journalContentChunks,
  journalPageSummary,
  prepareJournalRead,
} from '../journal-read.js';
import type { WorldJournal, WorldJournalPage } from '../types.js';

const JOURNAL_ID = 'Journal000000001';
const PAGE_ID = 'Page000000000001';

function page(overrides: Partial<WorldJournalPage> = {}): WorldJournalPage {
  return {
    _id: PAGE_ID,
    name: 'Page',
    type: 'text',
    text: { content: '', format: 1 },
    sort: 0,
    ...overrides,
  };
}

function prepare(value: WorldJournalPage) {
  const prepared = prepareJournalRead({ _id: JOURNAL_ID, name: 'Journal', pages: [value] })
    .pages[0];
  if (!prepared) {
    throw new Error('expected prepared journal page');
  }
  return prepared;
}

describe('journal read preparation', () => {
  it('extracts inert structured text from malformed HTML and decodes entities', () => {
    expect(
      htmlToJournalText(
        '<h1>Heading &amp; 😀</h1><p>one<br>two<div>nested</p>tail</div>' +
          '<script>secret()</script><style>.hidden{}</style><template>hidden</template>',
      ),
    ).toBe('Heading & 😀\none\ntwo\nnested\ntail');
  });

  it('handles deeply nested HTML without recursive traversal', () => {
    const depth = 20_000;
    const source = `${'<div>'.repeat(depth)}deep${'</div>'.repeat(depth)}`;
    expect(htmlToJournalText(source)).toBe('deep');
  });

  it('rejects HTML trees above the explicit traversal capacity', () => {
    const source = '<i>x</i>'.repeat(Math.floor(JOURNAL_MAX_HTML_NODES / 2) + 1);
    expect(() => htmlToJournalText(source)).toThrow(
      `Journal page HTML exceeds the maximum of ${JOURNAL_MAX_HTML_NODES} nodes`,
    );
  });

  it.each([
    0, 499, 500, 501, 10_001,
  ])('round-trips source and bounds previews at %i Unicode code points', (length) => {
    const source = '😀'.repeat(length);
    const prepared = prepare(page({ text: { content: source, format: 2 } }));
    const summary = journalPageSummary(prepared);
    const content = journalContentChunks(prepared, 'source');

    expect(summary.content).toBe('😀'.repeat(Math.min(length, 500)));
    expect(summary.contentTruncated).toBe(length > 500);
    expect(content.contentLength).toBe(length);
    expect(content.chunks.map((chunk) => chunk.content).join('')).toBe(source);
    expect(content.chunks.every((chunk) => Array.from(chunk.content).length <= 1024)).toBe(true);
    expect(content.chunks.at(-1)?.end).toBe(length);
    expect(content.chunks).toHaveLength(Math.max(1, Math.ceil(length / 1024)));
  });

  it('keeps markdown intact and identifies Foundry source formats', () => {
    const markdown = '# Heading\n\n*literal* 😀';
    const prepared = prepare(page({ text: { content: markdown, format: 2 } }));
    expect(prepared.metadata.sourceFormat).toBe('markdown');
    expect(journalContentChunks(prepared, 'text').chunks[0]?.content).toBe(markdown);
    expect(journalContentChunks(prepared, 'source').chunks[0]?.content).toBe(markdown);
  });

  it('returns one empty chunk for empty text and no chunks for non-text pages', () => {
    expect(journalContentChunks(prepare(page()), 'text')).toEqual({
      contentLength: 0,
      chunks: [{ index: 0, start: 0, end: 0, content: '' }],
    });

    const image = prepare(
      page({
        type: 'image',
        text: undefined,
        src: 'images/map.webp',
        image: { caption: 'Map caption' },
      }),
    );
    expect(image.metadata).toMatchObject({
      sourceFormat: 'none',
      asset: { src: 'images/map.webp', caption: 'Map caption' },
    });
    expect(journalContentChunks(image, 'source')).toEqual({ contentLength: 0, chunks: [] });
  });

  it('sorts pages stably and changes the digest for content, order, and ownership edits', () => {
    const first = page({
      _id: 'Page000000000002',
      sort: 20,
      text: { content: 'second', format: 2 },
    });
    const second = page({
      _id: 'Page000000000003',
      sort: 10,
      text: { content: 'first', format: 2 },
    });
    const journal: WorldJournal = { _id: JOURNAL_ID, name: 'Journal', pages: [first, second] };
    const baseline = prepareJournalRead(journal);
    expect(baseline.pages.map((entry) => entry.metadata.id)).toEqual([
      'Page000000000003',
      'Page000000000002',
    ]);
    expect(
      prepareJournalRead({ ...journal, pages: [first, { ...second, sort: 30 }] }).digest,
    ).not.toBe(baseline.digest);
    expect(
      prepareJournalRead({
        ...journal,
        pages: [first, { ...second, text: { content: 'edited', format: 2 } }],
      }).digest,
    ).not.toBe(baseline.digest);
    expect(prepareJournalRead({ ...journal, ownership: { default: 1 } }).digest).not.toBe(
      baseline.digest,
    );
  });

  it('rejects oversized source and metadata instead of slicing stored values', () => {
    expect(() =>
      prepare(page({ text: { content: 'x'.repeat(JOURNAL_MAX_SOURCE_BYTES + 1), format: 1 } })),
    ).toThrow(/maximum size/);
    expect(() => prepare(page({ name: 'x'.repeat(1025) }))).toThrow(/maximum/);
    expect(() =>
      prepareJournalRead({
        _id: JOURNAL_ID,
        name: 'Journal',
        pages: Array.from({ length: 10_001 }, () => page()),
      }),
    ).toThrow(/maximum of 10000 pages/);
    expect(() =>
      prepare(
        page({
          ownership: { default: 4 },
        }),
      ),
    ).toThrow(/ownership metadata is malformed/);
    expect(() =>
      prepare(
        page({
          type: 'image',
          src: 'image.webp',
          image: [] as unknown as Record<string, unknown>,
        }),
      ),
    ).toThrow(/asset metadata is malformed/);
  });

  it('rejects an oversized aggregate snapshot before parsing any page HTML', () => {
    const overTraversalCapacity = '<i>x</i>'.repeat(Math.floor(JOURNAL_MAX_HTML_NODES / 2) + 1);
    const maximumSource = 'x'.repeat(JOURNAL_MAX_SOURCE_BYTES);
    const journal: WorldJournal = {
      _id: JOURNAL_ID,
      name: 'Journal',
      pages: [
        page({ text: { content: overTraversalCapacity, format: 1 } }),
        page({
          _id: 'Page000000000002',
          text: { content: maximumSource, format: 2 },
        }),
        page({
          _id: 'Page000000000003',
          text: { content: maximumSource, format: 2 },
        }),
      ],
    };

    expect(() => prepareJournalRead(journal)).toThrow(/Journal snapshot exceeds the maximum size/);
  });

  it('uses code-point offsets at every chunk boundary', () => {
    const source = `${'a'.repeat(JOURNAL_CONTENT_CHUNK_CODEPOINTS - 1)}😀b`;
    const chunks = journalContentChunks(
      prepare(page({ text: { content: source, format: 2 } })),
      'text',
    ).chunks;
    expect(chunks).toEqual([
      { index: 0, start: 0, end: 1024, content: `${'a'.repeat(1023)}😀` },
      { index: 1, start: 1024, end: 1025, content: 'b' },
    ]);
  });
});
