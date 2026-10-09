/** Version 1 world-document read contracts shared by runtime validation and MCP schemas. */
import { z } from 'zod';

/** Matches the existing Foundry document-ID boundary; UUIDs are not accepted as IDs. */
export const FOUNDRY_ID_PATTERN = /^[a-zA-Z0-9]{16}$/;
export const documentIdSchema = z.string().regex(FOUNDRY_ID_PATTERN);

const identity = {
  id: documentIdSchema,
  name: z.string(),
  type: z.string(),
  img: z.string().optional(),
};
const actorFields = {
  hp: z
    .strictObject({
      value: z.number().optional(),
      max: z.number().optional(),
      temp: z.number().optional(),
    })
    .optional(),
  ac: z.strictObject({ value: z.number() }).optional(),
  level: z.number().optional(),
  abilities: z
    .record(
      z.string(),
      z.strictObject({
        value: z.number().optional(),
        mod: z.number().optional(),
        save: z.number().optional(),
      }),
    )
    .optional(),
  skills: z
    .record(
      z.string(),
      z.strictObject({ value: z.number(), mod: z.number(), proficient: z.boolean().optional() }),
    )
    .optional(),
  experience: z.strictObject({ value: z.number(), max: z.number() }).optional(),
  currency: z.record(z.string(), z.number()).optional(),
  biography: z.string().optional(),
  notes: z.string().optional(),
};
const itemFields = {
  description: z.string().optional(),
  rarity: z.string().optional(),
  price: z.strictObject({ value: z.number(), denomination: z.string() }).optional(),
  weight: z.number().optional(),
  quantity: z.number().optional(),
  equipped: z.boolean().optional(),
  identified: z.boolean().optional(),
  damage: z
    .strictObject({
      parts: z.array(z.tuple([z.string(), z.string()])),
      versatile: z.string().optional(),
    })
    .optional(),
  range: z
    .strictObject({ value: z.number(), long: z.number().optional(), units: z.string() })
    .optional(),
  armor: z
    .strictObject({ value: z.number(), type: z.string(), dex: z.number().optional() })
    .optional(),
  level: z.number().optional(),
  school: z.string().optional(),
  components: z
    .strictObject({
      vocal: z.boolean(),
      somatic: z.boolean(),
      material: z.boolean(),
      value: z.string().optional(),
    })
    .optional(),
  duration: z.strictObject({ value: z.number(), units: z.string() }).optional(),
  itemRange: z.strictObject({ value: z.number(), units: z.string() }).optional(),
};
export const actorRecordSchema = z.strictObject({
  ...identity,
  documentType: z.literal('Actor'),
  uuid: z
    .string()
    .regex(/^Actor\.[a-zA-Z0-9]{16}$/)
    .optional(),
  ...actorFields,
});
export const itemRecordSchema = z.strictObject({
  ...identity,
  documentType: z.literal('Item'),
  uuid: z
    .string()
    .regex(/^Item\.[a-zA-Z0-9]{16}$/)
    .optional(),
  ...itemFields,
});

// Internal document validators preserve existing client fields; public records below
// select only explicitly declared display fields and never expose raw system/data.
export const actorDocumentSchema = z
  .object({
    _id: documentIdSchema,
    name: z.string(),
    type: z.string(),
    img: z.string().optional(),
    uuid: z.string().optional(),
    ...actorFields,
  })
  .passthrough();
export const itemDocumentSchema = z
  .object({
    _id: documentIdSchema,
    name: z.string(),
    type: z.string(),
    img: z.string().optional(),
    uuid: z.string().optional(),
    ...itemFields,
  })
  .passthrough();
const pagination = {
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().nonnegative(),
};
export const actorSearchDocumentSchema = z.object({
  actors: z.array(actorDocumentSchema),
  ...pagination,
});
export const itemSearchDocumentSchema = z.object({
  items: z.array(itemDocumentSchema),
  ...pagination,
});
export const actorSearchSchema = z.strictObject({
  schemaVersion: z.literal(1),
  documentType: z.literal('Actor'),
  records: z.array(actorRecordSchema),
  ...pagination,
});
export const itemSearchSchema = z.strictObject({
  schemaVersion: z.literal(1),
  documentType: z.literal('Item'),
  records: z.array(itemRecordSchema),
  ...pagination,
});
export const actorDetailsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  documentType: z.literal('Actor'),
  record: actorRecordSchema,
});
export const itemDetailsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  documentType: z.literal('Item'),
  record: itemRecordSchema,
});
export const actorSearchOutputSchema = z.toJSONSchema(actorSearchSchema, { target: 'draft-7' });
export const itemSearchOutputSchema = z.toJSONSchema(itemSearchSchema, { target: 'draft-7' });
export const actorDetailsOutputSchema = z.toJSONSchema(actorDetailsSchema, { target: 'draft-7' });
export const itemDetailsOutputSchema = z.toJSONSchema(itemDetailsSchema, { target: 'draft-7' });

export type ActorReadRecord = z.infer<typeof actorRecordSchema>;
export type ItemReadRecord = z.infer<typeof itemRecordSchema>;
export type ActorSearchEnvelope = z.infer<typeof actorSearchSchema>;
export type ItemSearchEnvelope = z.infer<typeof itemSearchSchema>;
export type ActorDetailsEnvelope = z.infer<typeof actorDetailsSchema>;
export type ItemDetailsEnvelope = z.infer<typeof itemDetailsSchema>;

/** Project a validated document onto the public allowlist, preserving false/zero/empty. */
function publicRecord<T extends z.ZodObject>(
  schema: T,
  value: unknown,
  documentType: 'Actor' | 'Item',
): z.output<T> {
  const document = (documentType === 'Actor' ? actorDocumentSchema : itemDocumentSchema).parse(
    value,
  );
  const record: Record<string, unknown> = { id: document._id, documentType };
  for (const key of Object.keys(schema.shape)) {
    if (key !== 'id' && key !== 'documentType' && document[key] !== undefined) {
      record[key] = document[key];
    }
  }
  if (record.uuid !== undefined && record.uuid !== `${documentType}.${document._id}`) {
    throw new Error(`Invalid ${documentType} UUID scope or identity`);
  }
  return schema.parse(record);
}
export function actorReadRecord(value: unknown): ActorReadRecord {
  return publicRecord(actorRecordSchema, value, 'Actor');
}
export function itemReadRecord(value: unknown): ItemReadRecord {
  return publicRecord(itemRecordSchema, value, 'Item');
}
