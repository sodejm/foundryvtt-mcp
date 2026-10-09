import type { PaginationMetadata } from '../../../foundry/pagination.js';

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
  };
}
