import { describe, expect, it } from 'vitest';
import {
  htmlToJournalText,
  JOURNAL_CONTENT_CHUNK_CODEPOINTS,
  JOURNAL_MAX_HTML_DEPTH,
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
    const depth = JOURNAL_MAX_HTML_DEPTH;
    const source = `${'<div>'.repeat(depth)}deep${'</div>'.repeat(depth)}`;
    expect(htmlToJournalText(source)).toBe('deep');
  });

  it.each([
    JOURNAL_MAX_HTML_DEPTH + 1,
    20_000,
  ])('rejects nesting depth %i during parsing before unbounded parser work', (depth) => {
    const source = `${'<div>'.repeat(depth)}deep${'</div>'.repeat(depth)}`;
    expect(() => htmlToJournalText(source)).toThrow(
      `Journal page HTML exceeds the maximum nesting depth of ${JOURNAL_MAX_HTML_DEPTH}`,
    );
    expect(htmlToJournalText('<p>fresh</p>')).toBe('fresh');
  });

  it('does not count closed or void siblings toward the nesting limit', () => {
    expect(htmlToJournalText('<p>x<br></p>'.repeat(JOURNAL_MAX_HTML_DEPTH + 1))).toBe(
      Array.from({ length: JOURNAL_MAX_HTML_DEPTH + 1 }, () => 'x').join('\n'),
    );
  });

  it('rejects HTML trees above the explicit traversal capacity', () => {
    const source = '<i>x</i>'.repeat(Math.floor(JOURNAL_MAX_HTML_NODES / 2) + 1);
    expect(() => htmlToJournalText(source)).toThrow(
      `Journal page HTML exceeds the maximum of ${JOURNAL_MAX_HTML_NODES} nodes`,
    );
  }, 20_000);

  it.each([
    0, 499, 500, 501, 10_001,
  ])('round-trips source and bounds previews at %i Unicode code points', (length) => {
    const source = '😀'.repeat(length);
    const prepared = prepare(page({ text: { markdown: source, format: 2 } }));
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
    const prepared = prepare(page({ text: { markdown: markdown, format: 2 } }));
    expect(prepared.metadata.sourceFormat).toBe('markdown');
    expect(journalContentChunks(prepared, 'text').chunks[0]?.content).toBe(markdown);
    expect(journalContentChunks(prepared, 'source').chunks[0]?.content).toBe(markdown);
  });

  it.each([
    { format: 1, content: '<p>HTML</p>', markdown: 'unused', expected: '<p>HTML</p>' },
    { format: 2, content: 'unused', markdown: '# Markdown', expected: '# Markdown' },
    { format: 1, markdown: 'unused', expected: '' },
    { format: 2, content: 'unused', expected: '' },
    { format: 1, content: null, expected: '' },
    { format: 2, markdown: null, expected: '' },
    { format: 99, content: 'unknown source', expected: 'unknown source' },
  ])('reads only the stored field for format $format: $expected', ({ expected, ...text }) => {
    const prepared = prepare(page({ text }));
    expect(
      journalContentChunks(prepared, 'source')
        .chunks.map((chunk) => chunk.content)
        .join(''),
    ).toBe(expected);
    if (text.format === 99) {
      expect(prepared.metadata.sourceFormat).toBe('unknown');
    }
  });

  it('accepts omitted text metadata as an empty unknown-format page', () => {
    const prepared = prepare(page({ text: undefined, sort: undefined }));
    expect(prepared.metadata).toMatchObject({ sourceFormat: 'unknown', sort: 0 });
    expect(journalPageSummary(prepared).content).toBe('');
  });

  it.each([null, [], 'invalid'])('rejects malformed text containers: %j', (text) => {
    expect(() => prepare(page({ text } as unknown as Partial<WorldJournalPage>))).toThrow(
      /text metadata is malformed/,
    );
  });

  it.each([123, false, {}, []])('rejects malformed selected Markdown source: %j', (markdown) => {
    expect(() =>
      prepare(page({ text: { format: 2, markdown } } as unknown as Partial<WorldJournalPage>)),
    ).toThrow(/content must be a string/);
  });

  it('preserves preformatted whitespace and ignores comments with structural breaks', () => {
    expect(
      htmlToJournalText('<p>before</p><!-- secret --><hr><pre>a  b\n c</pre><p>after</p>'),
    ).toBe('before\na  b\nc\nafter');
  });

  it.each([1, 6])('retains valid title heading level %i', (level) => {
    expect(prepare(page({ title: { show: true, level } })).metadata.title).toEqual({
      show: true,
      level,
    });
  });

  it.each([
    null,
    [],
    {},
    { show: 1, level: 1 },
    { show: false, level: 0 },
    { show: false, level: 7 },
    { show: true, level: 1.5 },
  ])('rejects malformed title metadata: %j', (title) => {
    expect(() => prepare(page({ title } as unknown as Partial<WorldJournalPage>))).toThrow(
      /title metadata is malformed/,
    );
  });

  it.each([
    NaN,
    Infinity,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects unsafe sort values: %j', (sort) => {
    expect(() => prepare(page({ sort }))).toThrow(/sort must be a safe integer/);
  });

  it.each([
    { _id: 'short' },
    { _id: 123 },
    { name: false },
    { type: 123 },
    { type: 'x'.repeat(129) },
    { type: 'image', src: 'x'.repeat(8193) },
    { type: 'video', src: 'video.webm', video: { caption: 'x'.repeat(4097) } },
    { type: 'video', src: 'video.webm', video: null },
  ])('rejects malformed or oversized page metadata: %j', (overrides) => {
    expect(() => prepare(page(overrides as unknown as Partial<WorldJournalPage>))).toThrow();
  });

  it.each([
    {
      type: 'video',
      src: 'video.webm',
      video: { caption: 'Video caption' },
      expected: { src: 'video.webm', caption: 'Video caption' },
    },
    { type: 'video', src: 'video.webm', expected: { src: 'video.webm' } },
    { type: 'custom', src: 'asset.dat', expected: { src: 'asset.dat' } },
  ])('projects bounded assets for $type pages', ({ expected, ...overrides }) => {
    const prepared = prepare(page(overrides));
    expect(prepared.metadata.asset).toEqual(expected);
    expect(journalContentChunks(prepared, 'text').chunks).toEqual([]);
  });

  it.each([
    null,
    [],
    'invalid',
    { '': 1 },
    { ['x'.repeat(1025)]: 1 },
    { default: -2 },
    { default: 4 },
    { default: 1.5 },
  ])('rejects malformed ownership metadata: %j', (ownership) => {
    expect(() => prepare(page({ ownership } as unknown as Partial<WorldJournalPage>))).toThrow(
      /ownership metadata is malformed/,
    );
  });

  it('canonicalizes ownership key order and invalidates the digest for page ownership changes', () => {
    const baseline: WorldJournal = {
      _id: JOURNAL_ID,
      name: 'Journal',
      pages: [page({ ownership: { b: 1, a: -1 } })],
    };
    const digest = prepareJournalRead(baseline).digest;
    expect(
      prepareJournalRead({ ...baseline, pages: [page({ ownership: { a: -1, b: 1 } })] }).digest,
    ).toBe(digest);
    expect(
      prepareJournalRead({ ...baseline, pages: [page({ ownership: { a: -1, b: 3 } })] }).digest,
    ).not.toBe(digest);
  });

  it('retains input order for tied sort values and accepts omitted page collections', () => {
    const prepared = prepareJournalRead({
      _id: JOURNAL_ID,
      name: 'Journal',
      pages: [page({ _id: 'Page000000000002' }), page()],
    });
    expect(prepared.pages.map((entry) => entry.metadata.id)).toEqual(['Page000000000002', PAGE_ID]);
    expect(prepareJournalRead({ _id: JOURNAL_ID, name: 'Journal' }).pages).toEqual([]);
  });

  it.each([
    { _id: 123 },
    { _id: 'short' },
    { name: null },
    { name: 'x'.repeat(1025) },
    { pages: {} },
  ])('rejects malformed journal metadata: %j', (overrides) => {
    expect(() =>
      prepareJournalRead({
        _id: JOURNAL_ID,
        name: 'Journal',
        ...overrides,
      } as unknown as WorldJournal),
    ).toThrow();
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

  it('accepts Foundry text pages with a null asset source', () => {
    const prepared = prepare(
      page({ src: null, text: { content: '<p>Visible text</p>', format: 1 } }),
    );
    expect(prepared.metadata).not.toHaveProperty('asset');
    expect(journalContentChunks(prepared, 'text').chunks[0]?.content).toBe('Visible text');
    expect(journalContentChunks(prepared, 'source').chunks[0]?.content).toBe('<p>Visible text</p>');
  });

  it('normalizes Foundry null text content to an empty page', () => {
    const prepared = prepare(page({ src: null, text: { content: null, format: 1 } }));
    expect(journalPageSummary(prepared)).toMatchObject({ content: '', contentTruncated: false });
    for (const format of ['text', 'source'] as const) {
      expect(journalContentChunks(prepared, format)).toEqual({
        contentLength: 0,
        chunks: [{ index: 0, start: 0, end: 0, content: '' }],
      });
    }
  });

  it('omits null asset captions while retaining the stored source', () => {
    const prepared = prepare(
      page({ type: 'image', src: 'images/map.webp', image: { caption: null } }),
    );
    expect(prepared.metadata.asset).toEqual({ src: 'images/map.webp' });
  });

  it.each([
    { text: { content: 123, format: 1 } },
    { src: 123 },
    { type: 'image', src: 'images/map.webp', image: { caption: 123 } },
  ])('rejects malformed values when accepting nullable Foundry fields: %j', (overrides) => {
    expect(() => prepare(page(overrides as Partial<WorldJournalPage>))).toThrow(/must be a string/);
  });

  it('sorts pages stably and changes the digest for content, order, and ownership edits', () => {
    const first = page({
      _id: 'Page000000000002',
      sort: 20,
      text: { markdown: 'second', format: 2 },
    });
    const second = page({
      _id: 'Page000000000003',
      sort: 10,
      text: { markdown: 'first', format: 2 },
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
        pages: [first, { ...second, text: { markdown: 'edited', format: 2 } }],
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
          text: { markdown: maximumSource, format: 2 },
        }),
        page({
          _id: 'Page000000000003',
          text: { markdown: maximumSource, format: 2 },
        }),
      ],
    };

    expect(() => prepareJournalRead(journal)).toThrow(/Journal snapshot exceeds the maximum size/);
  });

  it('uses code-point offsets at every chunk boundary', () => {
    const source = `${'a'.repeat(JOURNAL_CONTENT_CHUNK_CODEPOINTS - 1)}😀b`;
    const chunks = journalContentChunks(
      prepare(page({ text: { markdown: source, format: 2 } })),
      'text',
    ).chunks;
    expect(chunks).toEqual([
      { index: 0, start: 0, end: 1024, content: `${'a'.repeat(1023)}😀` },
      { index: 1, start: 1024, end: 1025, content: 'b' },
    ]);
  });
});
