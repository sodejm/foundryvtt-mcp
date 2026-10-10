import type { WorldReadMetadata } from '../../../foundry/freshness.js';
import type { PaginationMetadata } from '../../../foundry/pagination.js';

export function readMetadata(overrides: Partial<WorldReadMetadata> = {}): WorldReadMetadata {
  return {
    source: 'socket',
    freshness: 'current',
    worldId: 'test-world',
    sessionId: 'fixture-session',
    snapshotId: 'fixture-source-snapshot',
    revision: 1,
    capturedAt: '2024-06-01T12:00:00.000Z',
    observedAt: '2024-06-01T12:00:01.000Z',
    respondedAt: '2024-06-01T12:00:02.000Z',
    ...overrides,
  };
}

export function paginationMetadata(
  returnedCount: number,
  total = returnedCount,
  limit = 10,
): PaginationMetadata {
  return {
    total,
    page: 1,
    limit,
    returnedCount,
    nextCursor: returnedCount < total ? 'fixture-cursor' : null,
    complete: returnedCount === total,
    snapshotId: 'fixture-snapshot',
    expiresAt: '2099-01-01T00:00:00.000Z',
    consistency: 'snapshot',
    readMetadata: readMetadata(),
  };
}
