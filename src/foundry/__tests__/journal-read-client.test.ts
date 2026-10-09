import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrustedCallerContext } from '../caller-context.js';
import { FoundryClient } from '../client.js';
import { JournalReadUnavailableError } from '../journal-read.js';
import type { WorldData, WorldJournal, WorldUser } from '../types.js';

vi.mock('axios');
vi.mock('../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const JOURNAL_ID = 'Journal000000001';
const OTHER_JOURNAL_ID = 'Journal000000002';
const PAGE_ID = 'JPage00000000001';
const OTHER_PAGE_ID = 'JPage00000000002';
const SERVICE = 'Service000000001';
const PLAYER = 'Player0000000001';
const OTHER_GM = 'OtherGM000000001';
const WORLD = 'world-one';

type Listener = (...args: unknown[]) => void;

function user(_id: string, role: number): WorldUser {
  return { _id, name: _id, role, color: '#123456' };
}

function journal(overrides: Partial<WorldJournal> = {}): WorldJournal {
  return {
    _id: JOURNAL_ID,
    name: 'Journal',
    ownership: { default: 2 },
    pages: [
      {
        _id: PAGE_ID,
        name: 'Page',
        type: 'text',
        sort: 0,
        text: { format: 2, markdown: 'alpha' },
        ownership: { default: -1 },
      },
    ],
    ...overrides,
  };
}

function snapshot(journals: WorldJournal[]): WorldData {
  return {
    userId: SERVICE,
    release: { version: '14.369' },
    world: { id: WORLD, title: 'World' },
    system: { id: 'dnd5e' },
    modules: [],
    demoMode: false,
    actors: [],
    scenes: [],
    items: [],
    journal: journals,
    messages: [],
    combats: [],
    users: [user(SERVICE, 4), user(PLAYER, 1), user(OTHER_GM, 4)],
    activeUsers: [SERVICE, PLAYER, OTHER_GM],
    settings: [],
    folders: [],
    macros: [],
    playlists: [],
    tables: [],
    cards: [],
    packs: [],
  };
}

function serviceClient(journals: WorldJournal[]) {
  const client = new FoundryClient({ baseUrl: 'http://localhost:30000' });
  const world = snapshot(journals);
  Reflect.set(client, 'worldData', world);
  Reflect.set(client, 'snapshotWorldId', WORLD);
  Reflect.set(client, 'snapshotId', 'world-snapshot-1');
  Reflect.set(client, 'snapshotRevision', 1);
  Reflect.set(client, 'snapshotCapturedAt', '2026-01-01T00:00:00.000Z');
  Reflect.set(client, 'snapshotObservedAt', '2026-01-01T00:00:01.000Z');
  return { client, world };
}

function requireCursor(cursor: string | null): string {
  if (!cursor) {
    throw new Error('expected pagination cursor');
  }
  return cursor;
}

function buildMockSocket() {
  const listeners = new Map<string, Set<Listener>>();
  const worldAcks: Array<(value: unknown) => void> = [];
  const socket = {
    connected: true,
    on: vi.fn((event: string, listener: Listener) => {
      const eventListeners = listeners.get(event) ?? new Set<Listener>();
      eventListeners.add(listener);
      listeners.set(event, eventListeners);
      return socket;
    }),
    off: vi.fn((event: string, listener: Listener) => {
      listeners.get(event)?.delete(listener);
      return socket;
    }),
    emit: vi.fn((event: string, ...args: unknown[]) => {
      const ack = args.at(-1);
      if (event === 'world' && typeof ack === 'function') {
        worldAcks.push(ack as (value: unknown) => void);
      }
      return socket;
    }),
    disconnect: vi.fn(() => {
      socket.connected = false;
    }),
  };
  return { socket, worldAcks };
}

function delegatedClient() {
  const client = new FoundryClient({
    baseUrl: 'http://localhost:30000',
    authorizationMode: 'delegated',
    timeout: 100,
    retryAttempts: 0,
  });
  const mock = buildMockSocket();
  Reflect.set(client, 'socket', mock.socket);
  Reflect.set(client, 'socketGeneration', 1);
  Reflect.set(client, 'socketEpoch', 1);
  Reflect.set(client, 'socketUserId', SERVICE);
  Reflect.set(client, '_isConnected', true);
  return { client, mock };
}

function caller(overrides: Partial<TrustedCallerContext> = {}): TrustedCallerContext {
  return {
    callerId: 'transport-caller',
    userId: PLAYER,
    worldId: WORLD,
    sessionId: 'transport-session',
    ...overrides,
  };
}

async function runAuthorized<T>(
  client: FoundryClient,
  mock: ReturnType<typeof buildMockSocket>,
  context: TrustedCallerContext,
  value: WorldData,
  operation: () => Promise<T>,
): Promise<T> {
  const index = mock.worldAcks.length;
  const pending = client.runWithCaller(context, operation);
  expect(mock.worldAcks).toHaveLength(index + 1);
  mock.worldAcks[index]?.(structuredClone(value));
  return await pending;
}

beforeEach(() => {
  vi.mocked(axios.create).mockReturnValue({
    interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
  } as unknown as ReturnType<typeof axios.create>);
});

describe('journal read client', () => {
  it('pages summaries in sort order with Unicode-safe previews', async () => {
    const pages = Array.from({ length: 5 }, (_, index) => ({
      _id: `JPage${String(index + 1).padStart(11, '0')}`,
      name: `Page ${index + 1}`,
      type: 'text',
      sort: 5 - index,
      text: { format: 2, markdown: '🐉'.repeat(index === 0 ? 501 : 1) },
      ownership: { default: -1 },
    }));
    const { client } = serviceClient([journal({ pages })]);

    const first = await client.getJournalSummaryPage({ journalId: JOURNAL_ID });
    expect(first).toMatchObject({ id: JOURNAL_ID, total: 5, page: 1, limit: 4 });
    expect(first.pages.map((page) => page.sort)).toEqual([1, 2, 3, 4]);
    const second = await client.getJournalSummaryPage({
      journalId: JOURNAL_ID,
      cursor: requireCursor(first.nextCursor),
    });
    expect(second.pages.map((page) => page.sort)).toEqual([5]);
    expect(second.pages[0]).toMatchObject({ content: '🐉'.repeat(500), contentTruncated: true });
  });

  it('round-trips complete Unicode source across bounded chunks', async () => {
    const source = '<p>&amp;🐉</p>'.repeat(1_200);
    const value = journal({
      pages: [
        {
          _id: PAGE_ID,
          name: 'HTML',
          type: 'text',
          text: { format: 1, content: source },
          ownership: { default: -1 },
        },
      ],
    });
    const { client } = serviceClient([value]);
    const chunks: string[] = [];
    let result = await client.getJournalPageContent({
      journalId: JOURNAL_ID,
      pageId: PAGE_ID,
      format: 'source',
    });
    expect(result.page).toMatchObject({ id: PAGE_ID, sourceFormat: 'html' });
    expect(result.paginationPage).toBe(1);
    expect(result.contentLength).toBe(Array.from(source).length);
    expect(result.contentTruncated).toBe(true);
    for (;;) {
      chunks.push(...result.chunks.map((chunk) => chunk.content));
      if (!result.nextCursor) {
        break;
      }
      result = await client.getJournalPageContent({
        journalId: JOURNAL_ID,
        pageId: PAGE_ID,
        format: 'source',
        cursor: result.nextCursor,
      });
    }
    expect(chunks.join('')).toBe(source);
    expect(result.contentTruncated).toBe(false);
  });

  it('rejects malformed direct inputs and keeps missing identifiers generic', async () => {
    const { client } = serviceClient([journal()]);
    await expect(
      client.getJournalSummaryPage({ journalId: JOURNAL_ID, extra: true } as never),
    ).rejects.toThrow();
    await expect(client.getJournalSummaryPage({ journalId: 'short' })).rejects.toBeInstanceOf(
      JournalReadUnavailableError,
    );
    await expect(
      client.getJournalPageContent({ journalId: JOURNAL_ID, pageId: OTHER_PAGE_ID }),
    ).rejects.toThrow('Journal unavailable');
    await expect(client.getJournalSummaryPage({ journalId: OTHER_JOURNAL_ID })).rejects.toThrow(
      'Journal unavailable',
    );
    await expect(
      client.getJournalSummaryPage({ journalId: JOURNAL_ID, limit: 9 }),
    ).rejects.toThrow();
  });

  it('binds continuation to limit, format, journal, caller, and connection', async () => {
    const content = 'x'.repeat(6_000);
    const firstJournal = journal({
      pages: [
        {
          _id: PAGE_ID,
          name: 'Page',
          type: 'text',
          text: { format: 2, markdown: content },
          ownership: { default: -1 },
        },
      ],
    });
    const otherJournal = journal({
      _id: OTHER_JOURNAL_ID,
      pages: [
        {
          _id: PAGE_ID,
          name: 'Other',
          type: 'text',
          text: { format: 2, markdown: content },
          ownership: { default: -1 },
        },
      ],
    });
    const { client, world } = serviceClient([firstJournal, otherJournal]);
    const first = await client.getJournalPageContent({
      journalId: JOURNAL_ID,
      pageId: PAGE_ID,
      limit: 1,
    });
    const cursor = requireCursor(first.nextCursor);
    await expect(
      client.getJournalPageContent({ journalId: JOURNAL_ID, pageId: PAGE_ID, limit: 2, cursor }),
    ).rejects.toThrow(/limit/);
    await expect(
      client.getJournalPageContent({
        journalId: JOURNAL_ID,
        pageId: PAGE_ID,
        format: 'source',
        cursor,
      }),
    ).rejects.toThrow(/query, world, or caller/);
    await expect(
      client.getJournalPageContent({ journalId: OTHER_JOURNAL_ID, pageId: PAGE_ID, cursor }),
    ).rejects.toThrow(/query, world, or caller/);
    world.userId = OTHER_GM;
    await expect(
      client.getJournalPageContent({ journalId: JOURNAL_ID, pageId: PAGE_ID, cursor }),
    ).rejects.toThrow(/query, world, or caller/);
    world.userId = SERVICE;
    Reflect.set(client, 'paginationSession', 'replacement-session');
    await expect(
      client.getJournalPageContent({ journalId: JOURNAL_ID, pageId: PAGE_ID, cursor }),
    ).rejects.toThrow(/query, world, or caller/);
    await expect(
      client.getJournalPageContent({
        journalId: JOURNAL_ID,
        pageId: PAGE_ID,
        cursor: `${cursor}x`,
      }),
    ).rejects.toThrow(/cursor/i);
  });

  it.each([
    'content',
    'sort',
    'ownership',
  ] as const)('invalidates page cursors after %s mutation', async (mutation) => {
    const value = journal({
      pages: [
        {
          _id: PAGE_ID,
          name: 'Page',
          type: 'text',
          sort: 1,
          text: { format: 2, markdown: 'x'.repeat(6_000) },
          ownership: { default: -1 },
        },
        {
          _id: OTHER_PAGE_ID,
          name: 'Other',
          type: 'text',
          sort: 2,
          text: { format: 2, markdown: 'other' },
          ownership: { default: -1 },
        },
      ],
    });
    const { client } = serviceClient([value]);
    const first = await client.getJournalPageContent({
      journalId: JOURNAL_ID,
      pageId: PAGE_ID,
      limit: 1,
    });
    const page = value.pages?.[0];
    if (!page) {
      throw new Error('expected page');
    }
    if (mutation === 'content') {
      page.text = { format: 2, markdown: 'y'.repeat(6_000) };
    }
    if (mutation === 'sort') {
      page.sort = 3;
    }
    if (mutation === 'ownership') {
      page.ownership = { default: 3 };
    }
    await expect(
      client.getJournalPageContent({
        journalId: JOURNAL_ID,
        pageId: PAGE_ID,
        cursor: requireCursor(first.nextCursor),
      }),
    ).rejects.toThrow(/query, world, or caller/);
  });

  it('invalidates page cursors after deletion', async () => {
    const value = journal({
      pages: [
        {
          _id: PAGE_ID,
          name: 'Page',
          type: 'text',
          text: { format: 2, markdown: 'x'.repeat(6_000) },
          ownership: { default: -1 },
        },
      ],
    });
    const { client } = serviceClient([value]);
    const first = await client.getJournalPageContent({ journalId: JOURNAL_ID, pageId: PAGE_ID });
    value.pages = [];
    await expect(
      client.getJournalPageContent({
        journalId: JOURNAL_ID,
        pageId: PAGE_ID,
        cursor: requireCursor(first.nextCursor),
      }),
    ).rejects.toThrow('Journal unavailable');
  });

  it('projects permissions before summaries, counts, assets, and cursors', async () => {
    const visible = journal({
      pages: [
        {
          _id: PAGE_ID,
          name: 'Visible',
          type: 'text',
          text: { format: 2, markdown: 'visible' },
          ownership: { default: -1 },
        },
        {
          _id: OTHER_PAGE_ID,
          name: 'Secret name',
          type: 'image',
          src: 'secret.webp',
          image: { caption: 'secret caption' },
          ownership: { [PLAYER]: 1 },
        },
      ],
    });
    const hidden = journal({
      _id: OTHER_JOURNAL_ID,
      name: 'Secret journal',
      ownership: { [PLAYER]: 1 },
      pages: [
        {
          _id: PAGE_ID,
          name: 'Explicitly allowed child',
          type: 'text',
          text: { format: 2, markdown: 'parent still denies access' },
          ownership: { [PLAYER]: 3 },
        },
      ],
    });
    const value = snapshot([visible, hidden]);
    const { client, mock } = delegatedClient();
    const summary = await runAuthorized(client, mock, caller(), value, () =>
      client.getJournalSummaryPage({ journalId: JOURNAL_ID }),
    );
    expect(summary.total).toBe(1);
    expect(JSON.stringify(summary)).not.toContain('secret');
    await expect(
      runAuthorized(client, mock, caller(), value, () =>
        client.getJournalPageContent({ journalId: JOURNAL_ID, pageId: OTHER_PAGE_ID }),
      ),
    ).rejects.toThrow('Journal unavailable');
    await expect(
      runAuthorized(client, mock, caller(), value, () =>
        client.getJournalSummaryPage({ journalId: OTHER_JOURNAL_ID }),
      ),
    ).rejects.toThrow('Journal unavailable');
    await expect(
      runAuthorized(client, mock, caller(), value, () =>
        client.getJournalPageContent({ journalId: OTHER_JOURNAL_ID, pageId: PAGE_ID }),
      ),
    ).rejects.toThrow('Journal unavailable');
  });

  it('binds delegated continuation to the transport caller', async () => {
    const value = snapshot([
      journal({
        pages: [
          {
            _id: PAGE_ID,
            name: 'Page',
            type: 'text',
            text: { format: 2, markdown: 'x'.repeat(6_000) },
            ownership: { default: -1 },
          },
        ],
      }),
    ]);
    const { client, mock } = delegatedClient();
    const first = await runAuthorized(client, mock, caller(), value, () =>
      client.getJournalPageContent({ journalId: JOURNAL_ID, pageId: PAGE_ID, limit: 1 }),
    );
    await expect(
      runAuthorized(client, mock, caller({ callerId: 'different-transport' }), value, () =>
        client.getJournalPageContent({
          journalId: JOURNAL_ID,
          pageId: PAGE_ID,
          cursor: requireCursor(first.nextCursor),
        }),
      ),
    ).rejects.toThrow(/query, world, or caller/);
  });
});
