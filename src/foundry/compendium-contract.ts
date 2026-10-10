/** Versioned, redacted contracts for optional Foundry integrations. */
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { paginationShape } from './read-contract.js';

const textFilter = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[^:,\r\n]+$/);
const filters = {
  compendiumId: textFilter.optional(),
  packType: textFilter.optional(),
  itemType: textFilter.optional(),
  spellLevel: z.number().int().nonnegative().optional(),
  source: z.string().trim().min(1).max(128).optional(),
};
const pageInput = {
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(1024).optional(),
};
export const compendiumParamsSchema = z.strictObject({
  query: z.string().max(1024).default(''),
  ...filters,
  ...pageInput,
});
export const compendiumSearchInputSchema = z.strictObject({
  query: z.string().max(1024),
  filters: z.strictObject(filters).optional(),
  ...pageInput,
});
const capabilityFields = {
  feature: z.enum(['compendiumSearch', 'rulesLookup', 'diagnostics', 'contentGeneration']),
  reason: z.string(),
  remediation: z.string().nullable(),
  verifiedAt: z.iso.datetime(),
  transport: z.literal('rest'),
};
export const capabilitySchema = z.strictObject({
  ...capabilityFields,
  status: z.enum(['available', 'unavailable', 'unauthorized', 'unreachable', 'incompatible']),
});
export const capabilitiesInputSchema = z.strictObject({});
export const capabilitiesReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  capabilities: z.array(capabilitySchema),
});
export const compendiumEntrySchema = z.strictObject({
  compendiumId: z.string().min(1),
  itemId: z.string().min(1),
  name: z.string().min(1),
  type: z.string(),
  img: z.string().optional(),
  system: z
    .strictObject({
      level: z.number().int().nonnegative().optional(),
      school: z.string().optional(),
      source: z
        .strictObject({ rules: z.string().optional(), custom: z.string().optional() })
        .optional(),
    })
    .optional(),
});
export const compendiumSearchSchema = z.discriminatedUnion('restAvailable', [
  z.strictObject({
    schemaVersion: z.literal(1),
    capability: z.strictObject({
      ...capabilityFields,
      feature: z.literal('compendiumSearch'),
      status: z.literal('available'),
    }),
    restAvailable: z.literal(true),
    results: z.array(compendiumEntrySchema),
    ...paginationShape,
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    capability: z.strictObject({
      ...capabilityFields,
      feature: z.literal('compendiumSearch'),
      status: z.enum(['unavailable', 'unauthorized', 'unreachable', 'incompatible']),
    }),
    restAvailable: z.literal(false),
    results: z.null(),
    total: z.null(),
    page: z.null(),
    limit: z.number().int().min(1).max(100),
    nextCursor: z.null(),
  }),
]);
export const compendiumSearchInputJsonSchema = z.toJSONSchema(compendiumSearchInputSchema, {
  target: 'draft-7',
});
export const compendiumSearchOutputSchema = {
  ...z.toJSONSchema(compendiumSearchSchema, { target: 'draft-7' }),
  type: 'object',
} as NonNullable<Tool['outputSchema']>;
export const capabilitiesInputJsonSchema = z.toJSONSchema(capabilitiesInputSchema, {
  target: 'draft-7',
});
export const capabilitiesOutputSchema = z.toJSONSchema(capabilitiesReportSchema, {
  target: 'draft-7',
});
