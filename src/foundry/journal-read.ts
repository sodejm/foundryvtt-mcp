import { createHash } from 'node:crypto';
import { type DefaultTreeAdapterMap, defaultTreeAdapter, parseFragment } from 'parse5';
import { MAX_SNAPSHOT_BYTES, MAX_SNAPSHOT_RECORDS } from './pagination.js';
import { FOUNDRY_ID_PATTERN } from './read-contract.js';
import type {
  JournalContentChunk,
  JournalContentFormat,
  JournalPageMetadata,
  JournalPageSummary,
  JournalSourceFormat,
  WorldJournal,
  WorldJournalPage,
} from './types.js';

export const JOURNAL_DEFAULT_PAGE_LIMIT = 4;
export const JOURNAL_MAX_PAGE_LIMIT = 8;
export const JOURNAL_PREVIEW_CODEPOINTS = 500;
export const JOURNAL_CONTENT_CHUNK_CODEPOINTS = 1024;
export const JOURNAL_MAX_SOURCE_BYTES = 4 * 1024 * 1024;
export const JOURNAL_MAX_HTML_NODES = 100_000;
export const JOURNAL_MAX_HTML_DEPTH = 4096;

const MAX_NAME_CODEPOINTS = 1024;
const MAX_TYPE_CODEPOINTS = 128;
const MAX_ASSET_SOURCE_CODEPOINTS = 8192;
const MAX_ASSET_CAPTION_CODEPOINTS = 4096;

const OMITTED_HTML_ELEMENTS = new Set([
  'canvas',
  'embed',
  'iframe',
  'math',
  'noscript',
  'object',
  'script',
  'style',
  'svg',
  'template',
]);

const BLOCK_HTML_ELEMENTS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'dd',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
]);

type HtmlNode = DefaultTreeAdapterMap['node'];

interface HtmlEnterFrame {
  phase: 'enter';
  node: HtmlNode;
  preserveWhitespace: boolean;
}

interface HtmlExitBlockFrame {
  phase: 'exit-block';
}

type HtmlTraversalFrame = HtmlEnterFrame | HtmlExitBlockFrame;

interface PreparedJournalPageInput {
  metadata: JournalPageMetadata;
  source: string | null;
  digestInput: unknown;
}

/** Missing, denied, and malformed direct identifiers deliberately share one public error. */
export class JournalReadUnavailableError extends Error {
  override readonly name = 'JournalReadUnavailableError';

  constructor() {
    super('Journal unavailable');
  }
}

export interface PreparedJournalPage {
  metadata: JournalPageMetadata;
  /** Exact stored source for text pages; null for non-text pages. */
  source: string | null;
  /** Inert, displayable text for text pages; null for non-text pages. */
  text: string | null;
  /** Stable input used only to invalidate continuation cursors after visible changes. */
  digestInput: unknown;
}

export interface PreparedJournalRead {
  id: string;
  uuid: string;
  name: string;
  pages: PreparedJournalPage[];
  digest: string;
}

function codePoints(value: string): string[] {
  return Array.from(value);
}

function assertBoundedString(
  value: unknown,
  label: string,
  maximumCodePoints: number,
): asserts value is string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }
  if (codePoints(value).length > maximumCodePoints) {
    throw new Error(`${label} exceeds the maximum of ${maximumCodePoints} Unicode code points`);
  }
}

function assertStoredId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !FOUNDRY_ID_PATTERN.test(value)) {
    throw new Error(`${label} contains an invalid Foundry document ID`);
  }
}

function normalizedOwnership(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Journal ownership metadata is malformed');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [principal, level] of entries) {
    if (
      principal.length === 0 ||
      principal.length > MAX_NAME_CODEPOINTS ||
      !Number.isSafeInteger(level) ||
      (level as number) < -1 ||
      (level as number) > 3
    ) {
      throw new Error('Journal ownership metadata is malformed');
    }
  }
  return Object.fromEntries(
    entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
}

function sourceFormat(page: WorldJournalPage): JournalSourceFormat {
  if (page.type !== 'text') {
    return 'none';
  }
  if (page.text?.format === 1) {
    return 'html';
  }
  if (page.text?.format === 2) {
    return 'markdown';
  }
  return 'unknown';
}

function appendStructuralBreak(parts: string[]): void {
  const tail = parts.at(-1);
  if (tail === undefined || tail === '\n' || tail.endsWith('\n')) {
    return;
  }
  parts.push('\n');
}

function renderHtmlTree(root: HtmlNode, parts: string[]): void {
  const stack: HtmlTraversalFrame[] = [{ phase: 'enter', node: root, preserveWhitespace: false }];
  let visitedNodes = 0;

  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) {
      break;
    }
    if (frame.phase === 'exit-block') {
      appendStructuralBreak(parts);
      continue;
    }

    visitedNodes += 1;
    if (visitedNodes > JOURNAL_MAX_HTML_NODES) {
      throw new Error(`Journal page HTML exceeds the maximum of ${JOURNAL_MAX_HTML_NODES} nodes`);
    }

    const { node, preserveWhitespace } = frame;
    if (node.nodeName === '#text') {
      const value = (node as DefaultTreeAdapterMap['textNode']).value;
      parts.push(preserveWhitespace ? value : value.replace(/[\t\n\f\r ]+/g, ' '));
      continue;
    }
    if (!('childNodes' in node)) {
      continue;
    }
    const element = 'tagName' in node ? node : undefined;
    const tagName = element?.tagName.toLowerCase();
    if (tagName && OMITTED_HTML_ELEMENTS.has(tagName)) {
      continue;
    }
    if (tagName === 'br' || tagName === 'hr') {
      appendStructuralBreak(parts);
      continue;
    }
    const isBlock = tagName !== undefined && BLOCK_HTML_ELEMENTS.has(tagName);
    if (isBlock) {
      appendStructuralBreak(parts);
      stack.push({ phase: 'exit-block' });
    }
    const childPreservesWhitespace = preserveWhitespace || tagName === 'pre';
    for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
      const child = node.childNodes[index];
      if (child !== undefined) {
        stack.push({ phase: 'enter', node: child, preserveWhitespace: childPreservesWhitespace });
      }
    }
  }
}

/** Parse HTML as inert data and retain useful document structure as newlines. */
export function htmlToJournalText(source: string): string {
  let openElements = 0;
  const fragment = parseFragment(source, {
    treeAdapter: {
      ...defaultTreeAdapter,
      onItemPush() {
        openElements += 1;
        // Fragment parsing also keeps one synthetic root on the open-element stack.
        if (openElements > JOURNAL_MAX_HTML_DEPTH + 1) {
          throw new Error(
            `Journal page HTML exceeds the maximum nesting depth of ${JOURNAL_MAX_HTML_DEPTH}`,
          );
        }
      },
      onItemPop() {
        openElements -= 1;
      },
    },
  });
  const parts: string[] = [];
  renderHtmlTree(fragment, parts);
  return parts
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^[ \t\n]+|[ \t\n]+$/g, '');
}

function pageTextSource(page: WorldJournalPage): string | null {
  if (page.type !== 'text') {
    return null;
  }
  if (page.text === undefined) {
    return '';
  }
  if (typeof page.text !== 'object' || page.text === null || Array.isArray(page.text)) {
    throw new Error('Journal page text metadata is malformed');
  }
  const source = Reflect.get(page.text, page.text.format === 2 ? 'markdown' : 'content');
  if (source === null || source === undefined) {
    return '';
  }
  if (typeof source !== 'string') {
    throw new Error('Journal page content must be a string');
  }
  const bytes = Buffer.byteLength(source, 'utf8');
  if (bytes > JOURNAL_MAX_SOURCE_BYTES) {
    throw new Error(
      `Journal page source exceeds the maximum size of ${JOURNAL_MAX_SOURCE_BYTES} bytes`,
    );
  }
  return source;
}

function pageTitle(page: WorldJournalPage): JournalPageMetadata['title'] {
  if (page.title === undefined) {
    return undefined;
  }
  if (
    typeof page.title !== 'object' ||
    page.title === null ||
    Array.isArray(page.title) ||
    typeof page.title.show !== 'boolean' ||
    !Number.isSafeInteger(page.title.level) ||
    page.title.level < 1 ||
    page.title.level > 6
  ) {
    throw new Error('Journal page title metadata is malformed');
  }
  return { show: page.title.show, level: page.title.level };
}

function pageAsset(page: WorldJournalPage): JournalPageMetadata['asset'] {
  if (page.src === undefined || page.src === null) {
    return undefined;
  }
  assertBoundedString(page.src, 'Journal page asset source', MAX_ASSET_SOURCE_CODEPOINTS);
  let caption: unknown;
  const settings =
    page.type === 'image' ? page.image : page.type === 'video' ? page.video : undefined;
  if (settings !== undefined) {
    if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
      throw new Error('Journal page asset metadata is malformed');
    }
    caption = Reflect.get(settings, 'caption');
  }
  if (caption === undefined || caption === null) {
    return { src: page.src };
  }
  assertBoundedString(caption, 'Journal page asset caption', MAX_ASSET_CAPTION_CODEPOINTS);
  return { src: page.src, caption };
}

function preparePageInput(journalId: string, page: WorldJournalPage): PreparedJournalPageInput {
  assertStoredId(page._id, 'Journal page');
  assertBoundedString(page.name, 'Journal page name', MAX_NAME_CODEPOINTS);
  assertBoundedString(page.type, 'Journal page type', MAX_TYPE_CODEPOINTS);
  const sort = page.sort ?? 0;
  if (!Number.isSafeInteger(sort)) {
    throw new Error('Journal page sort must be a safe integer');
  }
  const source = pageTextSource(page);
  const format = sourceFormat(page);
  const title = pageTitle(page);
  const asset = pageAsset(page);
  const metadata: JournalPageMetadata = {
    id: page._id,
    uuid: `JournalEntry.${journalId}.JournalEntryPage.${page._id}`,
    name: page.name,
    type: page.type,
    sort,
    sourceFormat: format,
    ...(title === undefined ? {} : { title }),
    ...(asset === undefined ? {} : { asset }),
  };
  return {
    metadata,
    source,
    digestInput: {
      metadata,
      source,
      ownership: normalizedOwnership(page.ownership),
    },
  };
}

function materializePage(input: PreparedJournalPageInput): PreparedJournalPage {
  const { metadata, source, digestInput } = input;
  const text =
    source === null ? null : metadata.sourceFormat === 'html' ? htmlToJournalText(source) : source;
  return { metadata, source, text, digestInput };
}

/** Validate and project one already-authorized journal into the public read model. */
export function prepareJournalRead(journal: WorldJournal): PreparedJournalRead {
  assertStoredId(journal._id, 'Journal');
  assertBoundedString(journal.name, 'Journal name', MAX_NAME_CODEPOINTS);
  if (journal.pages !== undefined && !Array.isArray(journal.pages)) {
    throw new Error('Journal pages must be an array');
  }
  if ((journal.pages?.length ?? 0) > MAX_SNAPSHOT_RECORDS) {
    throw new Error(`Journal snapshot exceeds the maximum of ${MAX_SNAPSHOT_RECORDS} pages`);
  }
  const pageInputs = (journal.pages ?? [])
    .map((page, originalIndex) => ({ page: preparePageInput(journal._id, page), originalIndex }))
    .sort(
      (left, right) =>
        left.page.metadata.sort - right.page.metadata.sort ||
        left.originalIndex - right.originalIndex,
    )
    .map(({ page }) => page);
  const digestInput = {
    id: journal._id,
    name: journal.name,
    ownership: normalizedOwnership(journal.ownership),
    pages: pageInputs.map((page) => page.digestInput),
  };
  const serializedDigestInput = JSON.stringify(digestInput);
  const digestBytes = Buffer.byteLength(serializedDigestInput, 'utf8');
  if (digestBytes > MAX_SNAPSHOT_BYTES) {
    throw new Error(`Journal snapshot exceeds the maximum size of ${MAX_SNAPSHOT_BYTES} bytes`);
  }
  return {
    id: journal._id,
    uuid: `JournalEntry.${journal._id}`,
    name: journal.name,
    pages: pageInputs.map(materializePage),
    digest: createHash('sha256').update(serializedDigestInput, 'utf8').digest('hex'),
  };
}

export function journalPageSummary(page: PreparedJournalPage): JournalPageSummary {
  const contentPoints = page.text === null ? [] : codePoints(page.text);
  return {
    ...page.metadata,
    content: contentPoints.slice(0, JOURNAL_PREVIEW_CODEPOINTS).join(''),
    contentTruncated: contentPoints.length > JOURNAL_PREVIEW_CODEPOINTS,
  };
}

export function journalContentChunks(
  page: PreparedJournalPage,
  format: JournalContentFormat,
): { contentLength: number; chunks: JournalContentChunk[] } {
  if (page.source === null || page.text === null) {
    return { contentLength: 0, chunks: [] };
  }
  const content = format === 'source' ? page.source : page.text;
  const points = codePoints(content);
  if (points.length === 0) {
    return { contentLength: 0, chunks: [{ index: 0, start: 0, end: 0, content: '' }] };
  }
  const chunks: JournalContentChunk[] = [];
  for (let start = 0; start < points.length; start += JOURNAL_CONTENT_CHUNK_CODEPOINTS) {
    const end = Math.min(start + JOURNAL_CONTENT_CHUNK_CODEPOINTS, points.length);
    chunks.push({ index: chunks.length, start, end, content: points.slice(start, end).join('') });
  }
  return { contentLength: points.length, chunks };
}
