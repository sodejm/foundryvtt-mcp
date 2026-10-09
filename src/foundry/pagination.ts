import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export interface PaginationParams {
  limit?: number;
  cursor?: string;
}

export interface PaginationMetadata {
  total: number;
  page: number;
  limit: number;
  returnedCount: number;
  nextCursor: string | null;
  complete: boolean;
  snapshotId: string;
  expiresAt: string;
  consistency: 'snapshot';
}

export interface CollectionRecord {
  id: string;
  name: string;
  documentType: 'Actor' | 'Item' | 'Scene' | 'JournalEntry' | 'User';
  type?: string;
  active?: boolean;
  pageCount?: number;
  role?: number;
}

export type CollectionPage = PaginationMetadata & { records: CollectionRecord[] };

export const DEFAULT_PAGE_LIMIT = 10;
export const MAX_PAGE_LIMIT = 100;
export const MAX_CURSOR_LENGTH = 1024;
export const MAX_FILTER_LENGTH = 1024;
export const MAX_PAGE_BYTES = 128 * 1024;
export const MAX_SNAPSHOT_RECORDS = 10_000;
export const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
export const MAX_CACHE_BYTES = 8 * 1024 * 1024;
export const MAX_CACHE_ENTRIES = 32;
export const SNAPSHOT_TTL_MS = 5 * 60 * 1000;

interface CursorPayload {
  v: 1;
  snapshotId: string;
  offset: number;
  contextHash: string;
  expiresAt: number;
}

interface Snapshot<T> {
  id: string;
  records: T[];
  limit: number;
  contextHash: string;
  expiresAt: number;
  bytes: number;
}

interface SnapshotPaginatorOptions {
  now?: () => number;
  secret?: Buffer | string;
}

export function validateBoundedText(
  value: unknown,
  label: string,
  maximumLength = MAX_FILTER_LENGTH,
): asserts value is string | undefined {
  if (value === undefined) {
    return;
  }
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }
  if (value.length > maximumLength) {
    throw new Error(`${label} exceeds the maximum length of ${maximumLength}`);
  }
}

function compareText(left: string, right: string): number {
  const normalizedLeft = left.normalize('NFKC').toLowerCase();
  const normalizedRight = right.normalize('NFKC').toLowerCase();
  if (normalizedLeft < normalizedRight) {
    return -1;
  }
  if (normalizedLeft > normalizedRight) {
    return 1;
  }
  return 0;
}

export function sortCollectionRecords(records: readonly CollectionRecord[]): CollectionRecord[] {
  return [...records].sort(
    (left, right) =>
      compareText(left.name, right.name) ||
      compareText(left.documentType, right.documentType) ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  );
}

export class SnapshotPaginator {
  private readonly snapshots = new Map<string, Snapshot<unknown>>();
  private readonly now: () => number;
  private readonly secret: Buffer;
  private cachedBytes = 0;

  constructor(options: SnapshotPaginatorOptions = {}) {
    this.now = options.now ?? Date.now;
    this.secret =
      typeof options.secret === 'string'
        ? Buffer.from(options.secret, 'utf8')
        : (options.secret ?? randomBytes(32));
  }

  clear(): void {
    this.snapshots.clear();
    this.cachedBytes = 0;
  }

  paginate<T>(
    records: readonly T[] | undefined,
    params: PaginationParams,
    context: unknown,
    defaultLimit = DEFAULT_PAGE_LIMIT,
  ): PaginationMetadata & { records: T[] } {
    validateBoundedText(params.cursor, 'cursor', MAX_CURSOR_LENGTH);
    const contextHash = this.hashContext(context);
    const now = this.now();
    this.evictExpired(now);

    let snapshot: Snapshot<T>;
    let offset = 0;

    if (params.cursor !== undefined) {
      const payload = this.decodeCursor(params.cursor);
      if (payload.expiresAt <= now) {
        throw new Error('Pagination cursor has expired');
      }
      const stored = this.snapshots.get(payload.snapshotId) as Snapshot<T> | undefined;
      if (!stored) {
        throw new Error('Pagination snapshot is no longer available');
      }
      if (stored.expiresAt !== payload.expiresAt) {
        throw new Error('Pagination cursor does not match its snapshot');
      }
      if (payload.contextHash !== contextHash || stored.contextHash !== contextHash) {
        throw new Error('Pagination cursor does not match the current query, world, or caller');
      }
      if (params.limit !== undefined && params.limit !== stored.limit) {
        throw new Error('Pagination cursor limit does not match the original request');
      }
      this.validateLimit(stored.limit);
      if (
        !Number.isSafeInteger(payload.offset) ||
        payload.offset <= 0 ||
        payload.offset >= stored.records.length
      ) {
        throw new Error('Pagination cursor contains an invalid offset');
      }
      snapshot = stored;
      offset = payload.offset;
    } else {
      const limit = params.limit ?? defaultLimit;
      this.validateLimit(limit);
      if (!records) {
        throw new Error('Pagination records are required for the first page');
      }
      if (records.length > MAX_SNAPSHOT_RECORDS) {
        throw new Error(
          `Pagination snapshot exceeds the maximum of ${MAX_SNAPSHOT_RECORDS} records`,
        );
      }
      const cloned = structuredClone([...records]);
      const bytes = Buffer.byteLength(JSON.stringify(cloned), 'utf8');
      if (bytes > MAX_SNAPSHOT_BYTES) {
        throw new Error(
          `Pagination snapshot exceeds the maximum size of ${MAX_SNAPSHOT_BYTES} bytes`,
        );
      }
      this.makeRoom(bytes);
      snapshot = {
        id: randomUUID(),
        records: cloned,
        limit,
        contextHash,
        expiresAt: now + SNAPSHOT_TTL_MS,
        bytes,
      };
      this.snapshots.set(snapshot.id, snapshot as Snapshot<unknown>);
      this.cachedBytes += bytes;
    }

    const end = Math.min(offset + snapshot.limit, snapshot.records.length);
    const pageRecords = structuredClone(snapshot.records.slice(offset, end));
    const complete = end >= snapshot.records.length;
    const metadata: PaginationMetadata = {
      total: snapshot.records.length,
      page: Math.floor(offset / snapshot.limit) + 1,
      limit: snapshot.limit,
      returnedCount: pageRecords.length,
      nextCursor: complete ? null : this.encodeCursor(snapshot, end),
      complete,
      snapshotId: snapshot.id,
      expiresAt: new Date(snapshot.expiresAt).toISOString(),
      consistency: 'snapshot',
    };
    const result = { records: pageRecords, ...metadata };
    const resultBytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
    if (resultBytes > MAX_PAGE_BYTES) {
      throw new Error(`Pagination page exceeds the maximum size of ${MAX_PAGE_BYTES} bytes`);
    }
    return result;
  }

  private validateLimit(limit: number): void {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
      throw new Error(`Pagination limit must be an integer between 1 and ${MAX_PAGE_LIMIT}`);
    }
  }

  private hashContext(context: unknown): string {
    const serialized = typeof context === 'string' ? context : JSON.stringify(context);
    return createHash('sha256').update(serialized).digest('base64url');
  }

  private encodeCursor(snapshot: Snapshot<unknown>, offset: number): string {
    const payload: CursorPayload = {
      v: 1,
      snapshotId: snapshot.id,
      offset,
      contextHash: snapshot.contextHash,
      expiresAt: snapshot.expiresAt,
    };
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const signature = createHmac('sha256', this.secret).update(encoded).digest('base64url');
    return `${encoded}.${signature}`;
  }

  private decodeCursor(cursor: string): CursorPayload {
    const parts = cursor.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error('Pagination cursor is malformed');
    }
    const expected = createHmac('sha256', this.secret).update(parts[0]).digest();
    if (!/^[A-Za-z0-9_-]+$/.test(parts[1])) {
      throw new Error('Pagination cursor is malformed');
    }
    const supplied = Buffer.from(parts[1], 'base64url');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new Error('Pagination cursor signature is invalid');
    }
    try {
      const payload = JSON.parse(
        Buffer.from(parts[0], 'base64url').toString('utf8'),
      ) as CursorPayload;
      if (
        payload.v !== 1 ||
        typeof payload.snapshotId !== 'string' ||
        typeof payload.offset !== 'number' ||
        typeof payload.contextHash !== 'string' ||
        typeof payload.expiresAt !== 'number'
      ) {
        throw new Error('invalid payload');
      }
      return payload;
    } catch {
      throw new Error('Pagination cursor payload is invalid');
    }
  }

  private evictExpired(now: number): void {
    for (const [id, snapshot] of this.snapshots) {
      if (snapshot.expiresAt <= now) {
        this.snapshots.delete(id);
        this.cachedBytes -= snapshot.bytes;
      }
    }
  }

  private makeRoom(bytes: number): void {
    while (this.snapshots.size >= MAX_CACHE_ENTRIES || this.cachedBytes + bytes > MAX_CACHE_BYTES) {
      // A snapshot can be no larger than the cache. Reaching this loop therefore
      // means at least one cached entry is available for eviction.
      const oldest = this.snapshots.entries().next().value as [string, Snapshot<unknown>];
      this.snapshots.delete(oldest[0]);
      this.cachedBytes -= oldest[1].bytes;
    }
  }
}
