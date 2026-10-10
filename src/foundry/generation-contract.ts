import { ErrorCode, McpError, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export const GENERATION_LABEL_MAX_LENGTH = 64;

const labelSchema = z.string().min(1).max(GENERATION_LABEL_MAX_LENGTH).regex(/\S/);

export const npcGenerationInputSchema = z.strictObject({
  level: z.number().int().min(1).max(20).default(1),
  race: labelSchema.default('Riverfolk'),
  class: labelSchema.default('Wayfinder'),
});

export const lootGenerationInputSchema = z.strictObject({
  challengeRating: z.number().finite().min(0).max(30).default(1),
  treasureType: z.enum(['individual', 'hoard']).default('individual'),
});

const limitationSchema = z.string().min(1).max(256);
const npcPreviewSchema = z.strictObject({
  mode: z.literal('creative-preview'),
  status: z.literal('preview'),
  persisted: z.literal(false),
  rulesVerified: z.literal(false),
  system: z.null(),
  systemVersion: z.null(),
  supportedOptions: z.tuple([z.literal('level'), z.literal('race'), z.literal('class')]),
  limitations: z.array(limitationSchema).min(1).max(4),
});
const lootPreviewSchema = npcPreviewSchema.extend({
  supportedOptions: z.tuple([z.literal('challengeRating'), z.literal('treasureType')]),
});

export const npcGenerationOutputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  preview: npcPreviewSchema,
  npc: z.strictObject({
    name: labelSchema,
    level: z.number().int().min(1).max(20),
    race: labelSchema,
    class: labelSchema,
    narrativeScale: z.enum(['local', 'notable', 'formidable', 'legendary']),
    personality: z.string().min(1).max(256),
    appearance: z.string().min(1).max(256),
    motivation: z.string().min(1).max(256),
    background: z.string().min(1).max(512),
  }),
  defaultsApplied: z.array(z.enum(['level', 'race', 'class'])).max(3),
});

const knownSubtotalSchema = z.strictObject({
  amount: z.number().int().nonnegative(),
  unit: z.literal('glints'),
});

export const lootGenerationOutputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  preview: lootPreviewSchema,
  loot: z.strictObject({
    challengeRating: z.number().finite().min(0).max(30),
    treasureType: z.enum(['individual', 'hoard']),
    denominations: z
      .array(
        z.strictObject({
          code: z.enum(['glint', 'crown']),
          name: z.enum(['glints', 'crowns']),
          amount: z.number().int().nonnegative(),
          unitValue: z.number().int().positive(),
        }),
      )
      .length(2),
    conversion: z.strictObject({
      baseUnit: z.literal('glints'),
      statement: z.literal('1 fictional crown equals 10 fictional glints.'),
    }),
    knownCurrencySubtotal: knownSubtotalSchema.extend({
      basis: z.literal('Sum of each denomination amount multiplied by its base-unit value.'),
    }),
    items: z
      .array(
        z.strictObject({
          name: labelSchema,
          description: z.string().min(1).max(256),
          valuation: z.strictObject({
            status: z.literal('unknown'),
            reason: z.string().min(1).max(256),
          }),
        }),
      )
      .max(3),
    overallValue: z.strictObject({
      status: z.literal('unknown'),
      knownCurrencySubtotal: knownSubtotalSchema,
      reason: z.string().min(1).max(256),
    }),
  }),
  defaultsApplied: z.array(z.enum(['challengeRating', 'treasureType'])).max(2),
});

export const npcGenerationInputJsonSchema = z.toJSONSchema(npcGenerationInputSchema, {
  target: 'draft-7',
}) as Tool['inputSchema'];
export const npcGenerationOutputJsonSchema = z.toJSONSchema(npcGenerationOutputSchema, {
  target: 'draft-7',
}) as NonNullable<Tool['outputSchema']>;
export const lootGenerationInputJsonSchema = z.toJSONSchema(lootGenerationInputSchema, {
  target: 'draft-7',
}) as Tool['inputSchema'];
export const lootGenerationOutputJsonSchema = z.toJSONSchema(lootGenerationOutputSchema, {
  target: 'draft-7',
}) as NonNullable<Tool['outputSchema']>;

export type NpcGenerationInput = z.infer<typeof npcGenerationInputSchema>;
export type NpcGenerationOutput = z.infer<typeof npcGenerationOutputSchema>;
export type LootGenerationInput = z.infer<typeof lootGenerationInputSchema>;
export type LootGenerationOutput = z.infer<typeof lootGenerationOutputSchema>;

export function parseNpcGenerationInput(value: unknown): NpcGenerationInput {
  const result = npcGenerationInputSchema.safeParse(value);
  if (!result.success) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid NPC generation parameters: ${result.error.message}`,
    );
  }
  return result.data;
}

export function parseLootGenerationInput(value: unknown): LootGenerationInput {
  const result = lootGenerationInputSchema.safeParse(value);
  if (!result.success) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid loot generation parameters: ${result.error.message}`,
    );
  }
  return result.data;
}
