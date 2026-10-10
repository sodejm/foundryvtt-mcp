import { ErrorCode, McpError, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export const RULE_LOOKUP_QUERY_MAX_LENGTH = 256;
export const RULE_LOOKUP_SYSTEM_MAX_LENGTH = 128;

export const ruleLookupInputSchema = z.strictObject({
  query: z.string().min(1).max(RULE_LOOKUP_QUERY_MAX_LENGTH).regex(/\S/),
  system: z.string().min(1).max(RULE_LOOKUP_SYSTEM_MAX_LENGTH).regex(/\S/).optional(),
});

export const ruleLookupCapabilitySchema = z.strictObject({
  feature: z.literal('rulesLookup'),
  status: z.literal('unavailable'),
  reason: z.string().min(1).max(512),
  remediation: z.string().min(1).max(512),
});

export const ruleLookupOutputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  capability: ruleLookupCapabilitySchema,
});

export const ruleLookupInputJsonSchema = z.toJSONSchema(ruleLookupInputSchema, {
  target: 'draft-7',
}) as Tool['inputSchema'];

export const ruleLookupOutputJsonSchema = z.toJSONSchema(ruleLookupOutputSchema, {
  target: 'draft-7',
}) as NonNullable<Tool['outputSchema']>;

export type RuleLookupInput = z.infer<typeof ruleLookupInputSchema>;
export type RuleLookupOutput = z.infer<typeof ruleLookupOutputSchema>;

export function parseRuleLookupInput(value: unknown): RuleLookupInput {
  const result = ruleLookupInputSchema.safeParse(value);
  if (!result.success) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid rule lookup parameters: ${result.error.message}`,
    );
  }
  return result.data;
}
