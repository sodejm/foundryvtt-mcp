import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { WorldReadMetadata } from '../freshness.js';

import {
  type CollectionRecord,
  MAX_CACHE_ENTRIES,
  MAX_CURSOR_LENGTH,
  MAX_PAGE_BYTES,
  MAX_SNAPSHOT_BYTES,
  SNAPSHOT_TTL_MS,
  SnapshotPaginator,
  sortCollectionRecords,
  validateBoundedText,
} from '../pagination.js';

function collect<T>(records: T[], limit: number): T[] {
  const paginator = new SnapshotPaginator({ secret: 'test-secret' });
  const result: T[] = [];
  let page = paginator.paginate(records, { limit }, { query: 'all' });
  for (;;) {
    result.push(...page.records);
    if (!page.nextCursor) {
      return result;
    }
    page = paginator.paginate<T>(undefined, { cursor: page.nextCursor }, { query: 'all' });
  }
}

function requireCursor(cursor: string | null): string {
  if (!cursor) {
    throw new Error('expected a pagination cursor');
  }
  return cursor;
}

function resign(
  cursor: string,
  secret: string,
  mutate: (payload: Record<string, unknown>) => void,
) {
  const [encoded] = cursor.split('.');
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
  mutate(payload);
  const changed = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(changed).digest('base64url');
  return `${changed}.${signature}`;
}

describe('SnapshotPaginator', () => {
  it('accepts generated, text, and binary signing secrets', () => {
    expect(new SnapshotPaginator().paginate([], {}, 'context').complete).toBe(true);
    expect(
      new SnapshotPaginator({ secret: Buffer.from('binary-secret') }).paginate([], {}, 'context')
        .complete,
    ).toBe(true);
  });

  it.each([0, 1, 10, 101, 251])('returns every record exactly once for %i records', (count) => {
    const records = Array.from({ length: count }, (_, index) => ({ id: `id-${index}` }));
    const output = collect(records, 10);
    expect(output).toEqual(records);
    expect(new Set(output.map(({ id }) => id)).size).toBe(count);
  });

  it('reports exact metadata at page boundaries', () => {
    const paginator = new SnapshotPaginator({ secret: 'test-secret' });
    const first = paginator.paginate([1, 2, 3, 4], { limit: 2 }, 'context');
    expect(first).toMatchObject({ total: 4, page: 1, limit: 2, returnedCount: 2, complete: false });
    const second = paginator.paginate<number>(
      undefined,
      { cursor: requireCursor(first.nextCursor) },
      'context',
    );
    expect(second).toMatchObject({
      records: [3, 4],
      page: 2,
      returnedCount: 2,
      complete: true,
      nextCursor: null,
    });
    expect(second.snapshotId).toBe(first.snapshotId);
    expect(second.consistency).toBe('snapshot');
  });

  it('supports the legacy numeric default-limit argument', () => {
    const paginator = new SnapshotPaginator({ secret: 'test-secret' });

    expect(paginator.paginate([1, 2, 3], {}, 'context', 2)).toMatchObject({
      records: [1, 2],
      limit: 2,
      returnedCount: 2,
      complete: false,
    });
  });

  it('supports deterministic cursor replay and isolates the snapshot from mutations', () => {
    const source = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
    const paginator = new SnapshotPaginator({ secret: 'test-secret' });
    const first = paginator.paginate(source, { limit: 1 }, { query: '' });
    source[1].name = 'changed';
    source.push({ name: 'd' });
    const next = paginator.paginate<{ name: string }>(
      undefined,
      { cursor: requireCursor(first.nextCursor) },
      { query: '' },
    );
    const replay = paginator.paginate<{ name: string }>(
      undefined,
      { cursor: requireCursor(first.nextCursor) },
      { query: '' },
    );
    expect(next).toEqual(replay);
    expect(next.records).toEqual([{ name: 'b' }]);
    next.records[0].name = 'consumer mutation';
    expect(
      paginator.paginate<{ name: string }>(
        undefined,
        { cursor: requireCursor(first.nextCursor) },
        { query: '' },
      ).records,
    ).toEqual([{ name: 'b' }]);
  });

  it('preserves source metadata across pages and marks an older revision stale', () => {
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const paginator = new SnapshotPaginator({ secret: 'test-secret', now: () => now });
    const source: WorldReadMetadata = {
      source: 'socket',
      freshness: 'current',
      worldId: 'world-1',
      sessionId: 'session-1',
      snapshotId: 'world-snapshot-1',
      revision: 1,
      capturedAt: '2025-12-31T23:59:58.000Z',
      observedAt: '2025-12-31T23:59:59.000Z',
      respondedAt: '2025-12-31T23:59:59.500Z',
    };
    const first = paginator.paginate([1, 2], { limit: 1 }, 'context', source);

    now += 1_000;
    const second = paginator.paginate<number>(
      undefined,
      { cursor: requireCursor(first.nextCursor) },
      'context',
      { ...source, snapshotId: 'world-snapshot-2', revision: 2 },
    );

    expect(first.snapshotId).not.toBe(source.snapshotId);
    expect(second.snapshotId).toBe(first.snapshotId);
    expect(second.readMetadata).toEqual({
      ...source,
      freshness: 'stale',
      respondedAt: '2026-01-01T00:00:01.000Z',
    });
  });

  it('binds cursors to context and limit and rejects corrupt cursors', () => {
    const paginator = new SnapshotPaginator({ secret: 'test-secret' });
    const first = paginator.paginate([1, 2], { limit: 1 }, { query: 'a', world: 'w', caller: 'c' });
    expect(() =>
      paginator.paginate(
        undefined,
        { cursor: requireCursor(first.nextCursor) },
        { query: 'b', world: 'w', caller: 'c' },
      ),
    ).toThrow(/query, world, or caller/);
    expect(() =>
      paginator.paginate(
        undefined,
        { cursor: requireCursor(first.nextCursor), limit: 2 },
        { query: 'a', world: 'w', caller: 'c' },
      ),
    ).toThrow(/limit/);
    expect(() => paginator.paginate(undefined, { cursor: 'bad' }, {})).toThrow(/malformed/);
    const [encoded, signature] = requireCursor(first.nextCursor).split('.');
    expect(() =>
      paginator.paginate(
        undefined,
        { cursor: `${encoded}.***` },
        { query: 'a', world: 'w', caller: 'c' },
      ),
    ).toThrow(/malformed/);
    const corruptSignature = `${signature?.[0] === 'A' ? 'B' : 'A'}${signature?.slice(1)}`;
    expect(() =>
      paginator.paginate(
        undefined,
        { cursor: `${encoded}.${corruptSignature}` },
        { query: 'a', world: 'w', caller: 'c' },
      ),
    ).toThrow(/signature/);
  });

  it('rejects expired, unavailable, mismatched, and invalid-offset snapshots', () => {
    let now = 1_000;
    const secret = 'test-secret';
    const paginator = new SnapshotPaginator({ secret, now: () => now });
    const first = paginator.paginate([1, 2], { limit: 1 }, 'context');
    expect(() =>
      paginator.paginate(
        undefined,
        {
          cursor: resign(requireCursor(first.nextCursor), secret, (payload) => {
            payload.v = 2;
          }),
        },
        'context',
      ),
    ).toThrow(/payload is invalid/);
    expect(() =>
      paginator.paginate(
        undefined,
        {
          cursor: resign(requireCursor(first.nextCursor), secret, (p) => {
            p.offset = 0;
          }),
        },
        'context',
      ),
    ).toThrow(/invalid offset/);
    expect(() =>
      paginator.paginate(
        undefined,
        {
          cursor: resign(requireCursor(first.nextCursor), secret, (p) => {
            p.expiresAt = Number(p.expiresAt) + 1;
          }),
        },
        'context',
      ),
    ).toThrow(/does not match/);
    paginator.clear();
    expect(() =>
      paginator.paginate(undefined, { cursor: requireCursor(first.nextCursor) }, 'context'),
    ).toThrow(/no longer available/);

    const expiring = paginator.paginate([1, 2], { limit: 1 }, 'context');
    now += SNAPSHOT_TTL_MS;
    expect(() =>
      paginator.paginate(undefined, { cursor: requireCursor(expiring.nextCursor) }, 'context'),
    ).toThrow(/expired/);
  });

  it('enforces all input and memory bounds without truncating', () => {
    const paginator = new SnapshotPaginator({ secret: 'test-secret' });
    for (const limit of [0, 1.5, 101]) {
      expect(() => paginator.paginate([], { limit }, 'context')).toThrow(/integer between/);
    }
    expect(() =>
      paginator.paginate([], { cursor: 'x'.repeat(MAX_CURSOR_LENGTH + 1) }, 'context'),
    ).toThrow(/maximum length/);
    expect(() =>
      paginator.paginate(
        Array.from({ length: 10_001 }, (_, i) => i),
        {},
        'context',
      ),
    ).toThrow(/10000 records/);
    expect(() =>
      paginator.paginate([{ value: 'x'.repeat(MAX_SNAPSHOT_BYTES + 1) }], {}, 'context'),
    ).toThrow(/maximum size|cache capacity/);
    expect(() =>
      paginator.paginate([{ value: 'x'.repeat(MAX_PAGE_BYTES) }], {}, 'context'),
    ).toThrow(/page exceeds/);
    expect(() => paginator.paginate(undefined, {}, 'context')).toThrow(/records are required/);
    expect(() => validateBoundedText(42, 'query')).toThrow(/string/);
    expect(() => validateBoundedText('x'.repeat(1025), 'query')).toThrow(/maximum length/);
  });

  it('evicts the oldest snapshot once the entry cap is reached', () => {
    const paginator = new SnapshotPaginator({ secret: 'test-secret' });
    const oldest = paginator.paginate([0, 1], { limit: 1 }, { index: 0 });
    for (let index = 1; index <= MAX_CACHE_ENTRIES; index += 1) {
      paginator.paginate([index, index + 1], { limit: 1 }, { index });
    }
    expect(() =>
      paginator.paginate(undefined, { cursor: requireCursor(oldest.nextCursor) }, { index: 0 }),
    ).toThrow(/no longer available/);
  });
});

describe('collection sorting', () => {
  it('uses case-sensitive opaque IDs to break otherwise identical record ties', () => {
    const upper: CollectionRecord = { id: 'A', name: 'same', documentType: 'Actor' };
    const lower: CollectionRecord = { id: 'a', name: 'same', documentType: 'Actor' };
    for (const records of [
      [lower, upper, upper],
      [upper, lower, upper],
    ]) {
      expect(sortCollectionRecords(records).map((record) => record.id)).toEqual(['A', 'A', 'a']);
    }
  });

  it('sorts normalized names and resolves case-only ties by document type then id', () => {
    const records: CollectionRecord[] = [
      { id: 'z', name: 'A', documentType: 'Item' },
      { id: 'b', name: 'a', documentType: 'Actor' },
      { id: 'a', name: 'A', documentType: 'Actor' },
      { id: 'c', name: 'b', documentType: 'Actor' },
    ];
    expect(sortCollectionRecords(records).map((record) => record.id)).toEqual(['a', 'b', 'z', 'c']);
    expect(records.map((record) => record.id)).toEqual(['z', 'b', 'a', 'c']);
  });
});
