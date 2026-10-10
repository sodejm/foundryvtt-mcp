import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import type { DiagnosticsClient } from '../../../diagnostics/client.js';
import type { FoundryClient } from '../../../foundry/client.js';
import type { WorldCombat } from '../../../foundry/types.js';
import { handleReadResource } from '../resources.js';
import { paginationMetadata, readMetadata } from './pagination-fixture.js';

const COMBAT_ID = 'cccccccccccccccc';

/**
 * Stored (creation) order deliberately differs from initiative order — the
 * same fixture the #214 combat specs use:
 *   stored:           Bob (5), Alice (18), Charlie (12)
 *   initiative order: Alice (18), Charlie (12), Bob (5)
 */
const makeUnsortedCombat = (overrides: Partial<WorldCombat> = {}): WorldCombat => ({
  _id: COMBAT_ID,
  active: true,
  round: 1,
  turn: 0,
  started: true,
  combatants: [
    { _id: 'bobbobbobbobbobb', name: 'Bob', initiative: 5, hidden: false, defeated: false },
    { _id: 'alicealicealice1', name: 'Alice', initiative: 18, hidden: false, defeated: false },
    { _id: 'charliecharlie11', name: 'Charlie', initiative: 12, hidden: false, defeated: false },
  ],
  ...overrides,
});

const stubDiagnostics = () =>
  ({
    getSystemHealth: vi.fn().mockRejectedValue(new Error('no REST')),
  }) as unknown as DiagnosticsClient;

/** Reads a resource and parses the single JSON content payload. */
const readJson = async (uri: string, client: Partial<FoundryClient>) => {
  const result = await handleReadResource(
    uri,
    { getReadMetadata: () => readMetadata(), ...client } as unknown as FoundryClient,
    stubDiagnostics(),
  );
  const text = result.contents[0]?.text ?? '';
  return JSON.parse(text) as Record<string, unknown>;
};

describe('bounded collection resources', () => {
  const collections = [
    ['actors', 'Actor', 'searchActors'],
    ['items', 'Item', 'searchItems'],
    ['scenes', 'Scene', 'getCollectionPage'],
    ['journals', 'JournalEntry', 'getCollectionPage'],
    ['users', 'User', 'getCollectionPage'],
  ] as const;
  it.each(
    collections,
  )('returns a default bounded %s page with stable IDs', async (collection, documentType, method) => {
    const record = { _id: 'Document00000001', name: 'Twin', type: 'npc' };
    const fetch = vi.fn().mockResolvedValue({
      ...(method === 'getCollectionPage'
        ? { records: [{ id: record._id, name: record.name, documentType }] }
        : { [collection]: [record] }),
      ...paginationMetadata(1, 1, 100),
    });
    const payload = await readJson(`foundry://${collection}`, { [method]: fetch });
    expect(payload).toMatchObject({
      schemaVersion: 3,
      collection,
      records: [{ id: record._id, documentType }],
      total: 1,
      limit: 100,
      returnedCount: 1,
      complete: true,
      nextCursor: null,
      nextUri: null,
    });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      ...(method === 'getCollectionPage' ? [collection, { limit: 100 }] : [{ limit: 100 }]),
    );
  });
  it('preserves and encodes the continuation context in nextUri', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue({ records: [], ...paginationMetadata(0, 2, 1), nextCursor: 'a+/=&?' });
    const first = await readJson('foundry://scenes?limit=1', { getCollectionPage: fetch });
    expect(first.nextUri).toBe('foundry://scenes?limit=1&cursor=a%2B%2F%3D%26%3F');
    await readJson(first.nextUri as string, { getCollectionPage: fetch });
    expect(fetch).toHaveBeenLastCalledWith('scenes', { limit: 1, cursor: 'a+/=&?' });
  });
  it('allows a cursor without an explicit limit for client-side context validation', async () => {
    const fetch = vi.fn().mockResolvedValue({ records: [], ...paginationMetadata(0) });
    await readJson('foundry://scenes?cursor=abc', { getCollectionPage: fetch });
    expect(fetch).toHaveBeenCalledExactlyOnceWith('scenes', { cursor: 'abc' });
  });
  it.each([
    'invalid URI',
    'https://actors',
    'foundry://unknown',
    'foundry://actors/',
    'foundry://actors#fragment',
    'foundry://user:password@actors',
    'foundry://actors:1234',
    'foundry://actors?limit=0',
    'foundry://actors?limit=101',
    'foundry://actors?limit=1.5',
    'foundry://actors?limit=01',
    'foundry://actors?limit=-1',
    'foundry://actors?limit=NaN',
    'foundry://actors?limit=1&limit=2',
    'foundry://actors?cursor=a&cursor=b',
    'foundry://actors?page=2',
    'foundry://actors?cursor=',
    `foundry://actors?cursor=${'a'.repeat(1025)}`,
  ])('rejects invalid collection URI before reading: %s', async (uri) => {
    const fetch = vi.fn();
    await expect(
      readJson(uri, { searchActors: fetch, getCollectionPage: fetch }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects malformed metadata and record identity', async () => {
    for (const page of [
      { records: [], ...paginationMetadata(0), total: -1 },
      { records: [{ id: 'short', name: 'bad', documentType: 'Scene' }], ...paginationMetadata(1) },
    ]) {
      await expect(
        readJson('foundry://scenes', { getCollectionPage: vi.fn().mockResolvedValue(page) }),
      ).rejects.toMatchObject({ code: ErrorCode.InternalError });
    }
  });
  it('reports backend and size failures without a partial collection', async () => {
    await expect(
      readJson('foundry://scenes', {
        getCollectionPage: vi.fn().mockRejectedValue(new Error('backend unavailable')),
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.InternalError,
      message: expect.stringContaining('backend unavailable'),
    });
    await expect(
      readJson('foundry://scenes', {
        getCollectionPage: vi.fn().mockResolvedValue({
          records: [{ id: 'Document00000001', name: 'é'.repeat(70_000), documentType: 'Scene' }],
          ...paginationMetadata(1),
        }),
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.InternalError,
      message: expect.stringContaining('request a smaller limit'),
    });
  });
});

// --------------------------------------------------------------------------
// #214 follow-up: `foundry://combat` is the id-bearing companion to
// `get_combat_state`, whose ordinals are initiative-ordered. Emitting the raw
// cached `combatants` array (creation order) next to a `turn` that indexes the
// initiative order makes `combatants[turn]` — and "the Nth name I just read" —
// resolve to the WRONG combatant.
// --------------------------------------------------------------------------
describe('foundry://combat resource', () => {
  it('emits combatants in initiative order, matching the ordinals get_combat_state prints', async () => {
    const combat = makeUnsortedCombat();
    const payload = await readJson('foundry://combat', {
      getCombatState: vi.fn().mockReturnValue(combat),
    });

    const emitted = payload.combat as WorldCombat;
    expect(emitted.combatants.map((c) => c.name)).toEqual(['Alice', 'Charlie', 'Bob']);
    // `get_combat_state` prints "3. **Bob**"; combatants[2] must be Bob's id.
    expect(emitted.combatants[2]?._id).toBe('bobbobbobbobbobb');
  });

  it('resolves `turn` against the emitted combatants array', async () => {
    const combat = makeUnsortedCombat({ turn: 1 });
    const payload = await readJson('foundry://combat', {
      getCombatState: vi.fn().mockReturnValue(combat),
    });

    const emitted = payload.combat as WorldCombat;
    expect(emitted.turn).toBe(1);
    expect(emitted.combatants[emitted.turn ?? 0]?.name).toBe('Charlie');
  });

  it('keeps the other Combat document fields intact', async () => {
    const combat = makeUnsortedCombat();
    const payload = await readJson('foundry://combat', {
      getCombatState: vi.fn().mockReturnValue(combat),
    });

    const emitted = payload.combat as WorldCombat;
    expect(emitted._id).toBe(COMBAT_ID);
    expect(emitted.round).toBe(1);
    expect(emitted.active).toBe(true);
    expect(emitted.started).toBe(true);
  });

  it('does not reorder the cached combatants array', async () => {
    const combat = makeUnsortedCombat();
    await readJson('foundry://combat', { getCombatState: vi.fn().mockReturnValue(combat) });

    expect(combat.combatants.map((c) => c.name)).toEqual(['Bob', 'Alice', 'Charlie']);
  });

  it('emits a null combat when no encounter is active', async () => {
    const payload = await readJson('foundry://combat', {
      getCombatState: vi.fn().mockReturnValue(null),
    });

    expect(payload.combat).toBeNull();
  });
});
