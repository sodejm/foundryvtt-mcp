/** World-document read contracts shared by runtime validation and MCP schemas. */
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
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
export const paginationShape = {
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().min(1).max(100),
  returnedCount: z.number().int().min(0).max(100),
  nextCursor: z.string().max(1024).nullable(),
  complete: z.boolean(),
  snapshotId: z.string(),
  expiresAt: z.iso.datetime(),
  consistency: z.literal('snapshot'),
};
export const paginationSchema = z.object(paginationShape);
const searchInput = {
  query: z.string().max(1024).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(1024).optional(),
};
export const worldSearchInputSchema = z.strictObject(searchInput);
export const actorSearchInputSchema = z.strictObject({
  ...searchInput,
  type: z.string().max(128).optional(),
});
export const itemSearchInputSchema = z.strictObject({
  ...actorSearchInputSchema.shape,
  rarity: z.string().max(128).optional(),
});
export const resourcePageInputSchema = z.strictObject({
  limit: searchInput.limit,
  cursor: searchInput.cursor,
});
export const actorSearchInputJsonSchema = z.toJSONSchema(actorSearchInputSchema, {
  target: 'draft-7',
});
export const itemSearchInputJsonSchema = z.toJSONSchema(itemSearchInputSchema, {
  target: 'draft-7',
});
export const worldSearchInputJsonSchema = z.toJSONSchema(worldSearchInputSchema, {
  target: 'draft-7',
});
export function boundedReadResponse<T>(response: T): T {
  if (Buffer.byteLength(JSON.stringify(response), 'utf8') > 128 * 1024) {
    throw new Error(
      'Read response exceeds the maximum size of 131072 bytes; request a smaller limit',
    );
  }
  return response;
}
export function parseReadInput<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid pagination parameters: ${result.error.message}`,
    );
  }
  return result.data;
}
export function paginationText(page: z.infer<typeof paginationSchema>): string {
  return `**Page:** ${page.page} | **Limit:** ${page.limit} | **Returned:** ${page.returnedCount}/${page.total} | **Complete:** ${page.complete}\n**Next cursor:** ${page.nextCursor ?? 'none'}\n**Snapshot expires:** ${page.expiresAt}`;
}
export const actorSearchDocumentSchema = z.object({
  actors: z.array(actorDocumentSchema),
  ...paginationShape,
});
export const itemSearchDocumentSchema = z.object({
  items: z.array(itemDocumentSchema),
  ...paginationShape,
});
export const actorSearchSchema = z.strictObject({
  schemaVersion: z.literal(2),
  documentType: z.literal('Actor'),
  records: z.array(actorRecordSchema),
  ...paginationShape,
});
export const itemSearchSchema = z.strictObject({
  schemaVersion: z.literal(2),
  documentType: z.literal('Item'),
  records: z.array(itemRecordSchema),
  ...paginationShape,
});
export const collectionRecordSchema = z.strictObject({
  id: documentIdSchema,
  name: z.string(),
  documentType: z.enum(['Actor', 'Item', 'Scene', 'JournalEntry', 'User']),
  type: z.string().optional(),
  active: z.boolean().optional(),
  pageCount: z.number().int().nonnegative().optional(),
  role: z.number().optional(),
});
export const collectionSearchSchema = z.strictObject({
  schemaVersion: z.literal(2),
  scope: z.enum(['journals', 'world']),
  records: z.array(collectionRecordSchema),
  ...paginationShape,
});
export const collectionSearchOutputSchema = z.toJSONSchema(collectionSearchSchema, {
  target: 'draft-7',
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
