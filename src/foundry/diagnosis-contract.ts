import { ErrorCode, McpError, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export const ERROR_DIAGNOSIS_CATEGORY_MAX_LENGTH = 128;

export const errorDiagnosisInputSchema = z.strictObject({
  category: z.string().min(1).max(ERROR_DIAGNOSIS_CATEGORY_MAX_LENGTH).regex(/\S/).optional(),
});

export const errorDiagnosisCapabilitySchema = z.strictObject({
  feature: z.literal('diagnostics'),
  status: z.literal('unavailable'),
  reason: z.string().min(1).max(512),
  remediation: z.string().min(1).max(512),
});

export const errorDiagnosisOutputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  capability: errorDiagnosisCapabilitySchema,
});

export const errorDiagnosisInputJsonSchema = z.toJSONSchema(errorDiagnosisInputSchema, {
  target: 'draft-7',
}) as Tool['inputSchema'];

export const errorDiagnosisOutputJsonSchema = z.toJSONSchema(errorDiagnosisOutputSchema, {
  target: 'draft-7',
}) as NonNullable<Tool['outputSchema']>;

export type ErrorDiagnosisInput = z.infer<typeof errorDiagnosisInputSchema>;
export type ErrorDiagnosisOutput = z.infer<typeof errorDiagnosisOutputSchema>;

export function parseErrorDiagnosisInput(value: unknown): ErrorDiagnosisInput {
  const result = errorDiagnosisInputSchema.safeParse(value);
  if (!result.success) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid error diagnosis parameters: ${result.error.message}`,
    );
  }
  return result.data;
}
