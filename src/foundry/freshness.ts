import { z } from 'zod';

export const worldReadMetadataSchema = z
  .object({
    source: z.enum(['socket', 'rest']),
    freshness: z.enum(['current', 'stale', 'unavailable']),
    worldId: z.string().min(1).nullable(),
    sessionId: z.string().min(1),
    snapshotId: z.string().min(1).nullable(),
    revision: z.number().int().nonnegative(),
    capturedAt: z.string().datetime({ offset: true }).nullable(),
    observedAt: z.string().datetime({ offset: true }).nullable(),
    respondedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type WorldReadMetadata = z.infer<typeof worldReadMetadataSchema>;
