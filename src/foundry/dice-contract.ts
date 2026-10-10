import { ErrorCode, McpError, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  MAX_DICE_FORMULA_LENGTH,
  MAX_DICE_PER_TERM,
  MAX_DICE_SIDES,
  MAX_DICE_TERMS,
} from './dice-formula.js';

export const DICE_REASON_MAX_LENGTH = 256;

const formulaSchema = z.string().min(1).max(MAX_DICE_FORMULA_LENGTH).regex(/\S/);
const reasonSchema = z.string().min(1).max(DICE_REASON_MAX_LENGTH).regex(/\S/);
const engineSchema = z.enum(['auto', 'local', 'foundry']);

export const diceRollInputSchema = z.strictObject({
  formula: formulaSchema,
  reason: reasonSchema.optional(),
  engine: engineSchema.default('auto'),
});

const advertisedDiceRollInputSchema = z.strictObject({
  formula: formulaSchema,
  reason: reasonSchema.optional(),
  engine: engineSchema.optional(),
});

const dieResultSchema = z.strictObject({
  result: z.number().int().safe().positive().max(MAX_DICE_SIDES),
  active: z.boolean(),
});

const outputModifierSchema = z.strictObject({
  type: z.enum(['kh', 'kl', 'dh', 'dl']),
  count: z.number().int().safe().positive().max(MAX_DICE_PER_TERM),
});

const outputDieSchema = z.strictObject({
  termIndex: z
    .number()
    .int()
    .safe()
    .nonnegative()
    .max(MAX_DICE_TERMS - 1),
  formula: z.string().min(1),
  count: z.number().int().safe().nonnegative().max(MAX_DICE_PER_TERM),
  faces: z.number().int().safe().positive().max(MAX_DICE_SIDES),
  modifier: z.union([z.null(), outputModifierSchema]),
  results: z.array(dieResultSchema).max(MAX_DICE_PER_TERM),
});

const autoFallbackSchema = z.strictObject({
  requestedEngine: z.literal('auto'),
  reason: z.enum(['foundry-transport-not-configured', 'foundry-execution-not-requested']),
});

export const diceRollOutputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  engine: z.enum(['local', 'foundry']),
  normalizedFormula: z.string().min(1),
  dice: z.array(outputDieSchema).max(MAX_DICE_TERMS),
  total: z.number().int().safe(),
  breakdown: z.string().min(1),
  timestamp: z.iso.datetime(),
  reason: z.string().min(1).max(DICE_REASON_MAX_LENGTH).regex(/\S/).optional(),
  fallback: z.union([z.null(), autoFallbackSchema]),
});

export const diceRollInputJsonSchema = z.toJSONSchema(advertisedDiceRollInputSchema, {
  target: 'draft-7',
}) as Tool['inputSchema'];

export const diceRollOutputJsonSchema = z.toJSONSchema(diceRollOutputSchema, {
  target: 'draft-7',
}) as NonNullable<Tool['outputSchema']>;

export type DiceRollInput = z.infer<typeof diceRollInputSchema>;
export type DiceRollOutput = z.infer<typeof diceRollOutputSchema>;

export function parseDiceRollInput(value: unknown): DiceRollInput {
  const result = diceRollInputSchema.safeParse(value);
  if (!result.success) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid dice roll parameters: ${result.error.message}`,
    );
  }
  return result.data;
}
