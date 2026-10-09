import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import Ajv from 'ajv';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiagnosticsClient } from '../../../diagnostics/client.js';
import type { FoundryClient } from '../../../foundry/client.js';
import { readMetadataText } from '../../../foundry/read-contract.js';
import { getAllTools } from '../../definitions.js';
import { handleGetActorDetails, handleSearchActors } from '../actors.js';
import { handleGetChatMessages } from '../chat.js';
import { handleGetCombatState } from '../combat.js';
import { handleGetHealthStatus } from '../diagnostics.js';
import { handleGetItemDetails, handleSearchItems } from '../items.js';
import { handleGetJournal, handleSearchJournals } from '../journals.js';
import { handleReadResource } from '../resources.js';
import { handleGetSceneInfo } from '../scenes.js';
import { handleGetUsers } from '../users.js';
import { availableReadMetadata, withToolError, withWorldRead } from '../utils.js';
import { handleGetWorldSummary, handleRefreshWorldData, handleSearchWorld } from '../world.js';
import { paginationMetadata, readMetadata } from './pagination-fixture.js';

const id = 'Document00000001';
const record = { _id: id, name: 'Fixture', type: 'npc' };
const stub = (methods: Record<string, unknown> = {}) =>
  ({ getReadMetadata: () => readMetadata(), ...methods }) as unknown as FoundryClient;
const diagnostics = (health?: unknown) =>
  ({
    getSystemHealth: health
      ? vi.fn().mockResolvedValue(health)
      : vi.fn().mockRejectedValue(new Error('REST unavailable')),
  }) as unknown as DiagnosticsClient;
const singletonReads = [
  ['users', handleGetUsers, { getUsers: () => ({ users: [], activeUsers: [] }) }],
  ['combat', handleGetCombatState, { getCombatState: () => null }],
  ['chat', handleGetChatMessages, { getChatMessages: () => [] }],
  [
    'scene',
    handleGetSceneInfo,
    { getCurrentScene: async () => ({ ...record, padding: 0, darkness: 0 }) },
  ],
  [
    'world',
    handleGetWorldSummary,
    { getWorldInfo: async () => ({ title: 'Test' }), getWorldSummary: () => ({ actors: 0 }) },
  ],
  [
    'refresh',
    handleRefreshWorldData,
    { refreshWorldData: async () => {}, getWorldSummary: () => ({ actors: 0 }) },
  ],
] as const;

afterEach(() => vi.useRealTimers());

describe('cached read freshness', () => {
  it.each(
    singletonReads,
  )('reports stale %s in both machine and text output', async (_name, handler, methods) => {
    const metadata = readMetadata({ freshness: 'stale' });
    const result = await handler({}, stub({ ...methods, getReadMetadata: () => metadata }));
    expect(result.structuredContent.readMetadata).toEqual(metadata);
    expect(result.content.at(-1)?.text).toContain('**Freshness:** stale');
  });
  it.each(
    singletonReads,
  )('rejects unavailable %s instead of a successful empty result', async (_name, handler, methods) => {
    await expect(
      handler(
        {},
        stub({ ...methods, getReadMetadata: () => readMetadata({ freshness: 'unavailable' }) }),
      ),
    ).rejects.toMatchObject({
      code: ErrorCode.InternalError,
      message: expect.stringContaining('World data unavailable'),
    });
  });
  it('adds freshness to journal content and preserves missing-document errors', async () => {
    const result = await handleGetJournal(
      { journalId: id },
      stub({ getJournal: () => ({ ...record, pages: [] }) }),
    );
    expect(result.structuredContent.readMetadata.freshness).toBe('current');
    await expect(
      handleGetJournal({ journalId: id }, stub({ getJournal: () => undefined })),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });
  it('reads metadata after recovery and preserves existing structured fields', async () => {
    let metadata = readMetadata({ freshness: 'unavailable' });
    const result = await withWorldRead(
      'refresh',
      stub({ getReadMetadata: () => metadata }),
      async () => {
        metadata = readMetadata();
        return { content: [], structuredContent: { count: 0 } };
      },
    );
    expect(result.structuredContent).toEqual({ count: 0, readMetadata: metadata });
  });
  it('rejects malformed metadata and converts non-Error failures without losing MCP errors', async () => {
    expect(() =>
      availableReadMetadata(stub({ getReadMetadata: () => ({ freshness: 'current' }) })),
    ).toThrow();
    await expect(
      withToolError('read', async () => {
        throw 'bad';
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.InternalError,
      message: expect.stringContaining('Unknown error'),
    });
  });
  it('renders unknown identity and absent source clocks truthfully', () => {
    expect(
      readMetadataText(
        readMetadata({
          freshness: 'unavailable',
          worldId: null,
          snapshotId: null,
          capturedAt: null,
          observedAt: null,
        }),
      ),
    ).toContain('**World:** unknown');
    expect(
      readMetadataText(readMetadata({ snapshotId: null, capturedAt: null, observedAt: null })),
    ).toContain('**Source snapshot:** none');
    expect(readMetadataText(readMetadata({ capturedAt: null, observedAt: null }))).toContain(
      '**Captured:** unavailable | **Observed:** unavailable',
    );
  });
});

describe('structured read source metadata', () => {
  const searches = [
    ['search_actors', handleSearchActors, 'searchActors', { actors: [record] }],
    ['search_items', handleSearchItems, 'searchItems', { items: [record] }],
    ['search_journals', handleSearchJournals, 'searchJournalsPage', { records: [] }],
    ['search_world', handleSearchWorld, 'searchWorldPage', { records: [] }],
  ] as const;
  it.each(
    searches,
  )('%s preserves the page capture rather than relabeling it with a newer cache revision', async (name, handler, method, data) => {
    const metadata = readMetadata({ freshness: 'stale', revision: 2 });
    const result = await handler(
      {},
      stub({
        [method]: async () => ({ ...data, ...paginationMetadata(0), readMetadata: metadata }),
        getReadMetadata: () => readMetadata({ revision: 3 }),
      }),
    );
    expect(result.structuredContent.readMetadata).toEqual(metadata);
    expect(result.content[0]?.text).toContain('**Revision:** 2');
    const schema = getAllTools().find((tool) => tool.name === name)?.outputSchema;
    const validate = new Ajv({ strict: false, validateFormats: false }).compile(schema as object);
    expect(validate(result.structuredContent)).toBe(true);
    expect(
      validate({
        ...result.structuredContent,
        readMetadata: readMetadata({ freshness: 'unavailable' }),
      }),
    ).toBe(false);
  });
  it.each(searches)('%s rejects an unavailable page', async (_name, handler, method, data) => {
    await expect(
      handler(
        {},
        stub({
          [method]: async () => ({
            ...data,
            ...paginationMetadata(0),
            readMetadata: readMetadata({ freshness: 'unavailable' }),
          }),
        }),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.InternalError });
  });
  it.each([
    [
      'actor',
      (client: FoundryClient) => handleGetActorDetails({ actorId: id }, client),
      'getActor',
    ],
    ['item', (client: FoundryClient) => handleGetItemDetails({ itemId: id }, client), 'getItem'],
  ] as const)('%s details expose stale data and reject unavailable data', async (_name, handler, method) => {
    const result = await handler(
      stub({
        [method]: async () => record,
        getReadMetadata: () => readMetadata({ freshness: 'stale' }),
      }),
    );
    expect(result.structuredContent.readMetadata.freshness).toBe('stale');
    expect(result.content[0]?.text).toContain('**Freshness:** stale');
    await expect(
      handler(
        stub({
          [method]: async () => record,
          getReadMetadata: () => readMetadata({ freshness: 'unavailable' }),
        }),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.InternalError });
  });
});

describe('resource and health source boundaries', () => {
  const read = async (uri: string, client: FoundryClient, rest = diagnostics()) => {
    const response = await handleReadResource(uri, client, rest);
    return JSON.parse(response.contents[0]?.text ?? '');
  };
  it.each([
    'foundry://scenes/current',
    'foundry://world/settings',
    'foundry://combat',
  ])('%s reports stale source metadata and rejects unavailable data', async (uri) => {
    const methods = {
      getCurrentScene: async () => {
        throw new Error('No active scene');
      },
      getWorldInfo: async () => ({ title: 'Test' }),
      getCombatState: () => null,
    };
    const payload = await read(
      uri,
      stub({ ...methods, getReadMetadata: () => readMetadata({ freshness: 'stale' }) }),
    );
    expect(payload.readMetadata.freshness).toBe('stale');
    expect(payload).not.toHaveProperty('lastUpdated');
    await expect(
      read(
        uri,
        stub({ ...methods, getReadMetadata: () => readMetadata({ freshness: 'unavailable' }) }),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.InternalError });
  });
  it('returns an active scene and propagates unexpected scene failures', async () => {
    expect(
      await read('foundry://scenes/current', stub({ getCurrentScene: async () => record })),
    ).toMatchObject({ currentScene: record, readMetadata: readMetadata() });
    for (const failure of [new Error('World unavailable'), 'unexpected']) {
      await expect(
        read(
          'foundry://scenes/current',
          stub({
            getCurrentScene: async () => {
              throw failure;
            },
          }),
        ),
      ).rejects.toMatchObject({ code: ErrorCode.InternalError });
    }
  });
  it('keeps REST capture, local observation and response times distinct', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2024-06-02T12:00:00Z');
    const health = { timestamp: '2024-06-01T12:00:00Z' };
    const payload = await read('foundry://system/diagnostics', stub(), diagnostics(health));
    expect(payload).toMatchObject({
      source: 'rest',
      freshness: 'current',
      capturedAt: health.timestamp,
      observedAt: '2024-06-02T12:00:00.000Z',
      respondedAt: '2024-06-02T12:00:00.000Z',
    });
    expect(await read('foundry://system/diagnostics', stub())).toMatchObject({
      source: 'rest',
      freshness: 'unavailable',
      capturedAt: null,
      observedAt: null,
    });
  });
  it('reports unavailable socket snapshots independently of successful REST diagnostics', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2024-06-02T12:00:00Z');
    const metadata = readMetadata({ freshness: 'unavailable', capturedAt: null, observedAt: null });
    const health = {
      timestamp: '2024-06-01T12:00:00Z',
      status: 'healthy',
      users: { active: 0, total: 1 },
      server: {},
      performance: {},
      logs: { recentErrors: 0, recentWarnings: 0 },
    };
    const result = await handleGetHealthStatus(
      {},
      stub({
        getWorldInfo: async () => {
          throw new Error('No snapshot');
        },
        isConnected: () => true,
        getReadMetadata: () => metadata,
      }),
      diagnostics(health),
    );
    expect(result.structuredContent).toMatchObject({
      connected: true,
      readMetadata: metadata,
      restDiagnostics: {
        source: 'rest',
        freshness: 'current',
        capturedAt: health.timestamp,
        observedAt: '2024-06-02T12:00:00.000Z',
        respondedAt: '2024-06-02T12:00:00.000Z',
      },
    });
    const unavailable = await handleGetHealthStatus(
      {},
      stub({
        getWorldInfo: async () => ({ title: 'Test' }),
        isConnected: () => false,
        getReadMetadata: () => readMetadata({ freshness: 'stale' }),
      }),
      diagnostics(),
    );
    expect(unavailable.structuredContent.restDiagnostics).toMatchObject({
      freshness: 'unavailable',
      capturedAt: null,
      observedAt: null,
      systemHealth: null,
    });
  });
});
