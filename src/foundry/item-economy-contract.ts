import { z } from 'zod';

export const ITEM_ECONOMY_SCHEMA_VERSION = 1;
export const ITEM_ECONOMY_TEXT_MAX_LENGTH = 256;
export const ITEM_ECONOMY_SOURCE_ARRAY_MAX_LENGTH = 16;
export const ITEM_ECONOMY_SOURCE_MAX_BYTES = 4096;

export const itemEconomyStatusSchema = z.enum([
  'known',
  'missing',
  'invalid',
  'not-applicable',
  'unsupported',
]);

const safeSourceScalarSchema = z.union([
  z.null(),
  z.boolean(),
  z.number().finite().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  z.string().max(ITEM_ECONOMY_TEXT_MAX_LENGTH),
]);
const safeSourceListSchema = z
  .array(safeSourceScalarSchema)
  .max(ITEM_ECONOMY_SOURCE_ARRAY_MAX_LENGTH);
const safeSourceValueSchema = z.union([safeSourceScalarSchema, safeSourceListSchema]);
const safeCoinSourceSchema = z.strictObject({
  cp: safeSourceScalarSchema.optional(),
  sp: safeSourceScalarSchema.optional(),
  gp: safeSourceScalarSchema.optional(),
  pp: safeSourceScalarSchema.optional(),
});
const safePriceSourceSchema = z.union([
  safeSourceValueSchema,
  z.strictObject({
    value: z.union([safeSourceValueSchema, safeCoinSourceSchema]).optional(),
    denomination: safeSourceScalarSchema.optional(),
    per: safeSourceScalarSchema.optional(),
  }),
]);

export const itemEconomySourceSchema = z.strictObject({
  price: safePriceSourceSchema.optional(),
  rarity: safeSourceValueSchema.optional(),
  rarities: safeSourceValueSchema.optional(),
  traits: z
    .strictObject({
      rarity: safeSourceValueSchema.optional(),
    })
    .optional(),
});

export const itemEconomySchema = z.strictObject({
  schemaVersion: z.literal(ITEM_ECONOMY_SCHEMA_VERSION),
  adapter: z.strictObject({
    systemId: z.string().min(1).max(128),
    systemVersion: z.string().min(1).max(128).nullable(),
    adapterId: z.enum(['dnd5e@6.0.6', 'pf2e@7.8.0']).nullable(),
    status: z.enum([
      'supported',
      'unsupported-system',
      'unsupported-version',
      'source-unavailable',
    ]),
  }),
  source: itemEconomySourceSchema,
  price: z.strictObject({
    status: itemEconomyStatusSchema,
    currencies: z
      .array(
        z.strictObject({
          denomination: z.string().min(1).max(32),
          value: z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER),
        }),
      )
      .max(4),
    per: z.number().int().safe().positive().nullable(),
  }),
  rarity: z.strictObject({
    status: itemEconomyStatusSchema,
    values: z.array(z.string().min(1).max(32)).max(16),
  }),
});

export type ItemEconomy = z.infer<typeof itemEconomySchema>;
export type ItemEconomySource = z.infer<typeof itemEconomySourceSchema>;
export type ItemEconomyStatus = z.infer<typeof itemEconomyStatusSchema>;
