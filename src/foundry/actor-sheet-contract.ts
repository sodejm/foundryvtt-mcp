import { z } from 'zod';
import {
  availableWorldReadMetadataSchema,
  documentIdSchema,
  paginationShape,
} from './read-contract.js';

export const ACTOR_SECTION_NAMES = [
  'attributes',
  'abilities',
  'skills',
  'details',
  'currency',
  'resources',
  'system',
] as const;

export const actorSectionNameSchema = z.enum(ACTOR_SECTION_NAMES);
export type ActorSectionName = z.infer<typeof actorSectionNameSchema>;

const boundedText = z.string().max(4096);
export const actorFieldValueSchema = z.union([
  boundedText,
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export const actorIdentitySchema = z.strictObject({
  id: documentIdSchema,
  uuid: z.string().regex(/^Actor\.[a-zA-Z0-9]{16}$/),
  name: z.string().max(512),
  type: z.string().max(128),
  img: z.string().max(2048).optional(),
});

export const actorSystemIdentitySchema = z.strictObject({
  id: z.string().max(128),
  version: z.string().max(128).optional(),
  profile: z.enum(['dnd5e', 'pf2e', 'generic']),
});

export const actorFieldSchema = z.strictObject({
  key: z.string().min(1).max(128),
  label: z.string().min(1).max(256),
  source: z.enum(['normalized', 'system-path']),
  path: z.string().min(1).max(512).optional(),
  present: z.boolean(),
  value: actorFieldValueSchema.optional(),
  truncated: z.boolean().optional(),
});

export const actorSectionDescriptorSchema = z.strictObject({
  name: actorSectionNameSchema,
  supported: z.boolean(),
  fieldCount: z.number().int().min(0).max(64),
});

export const actorSheetInputSchema = z.strictObject({ actorId: documentIdSchema });
export const actorSectionInputSchema = z.strictObject({
  actorId: documentIdSchema,
  section: actorSectionNameSchema,
});
export const actorItemListInputSchema = z.strictObject({
  actorId: documentIdSchema,
  query: z.string().max(1024).optional(),
  type: z.string().max(128).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(1024).optional(),
});
export const actorItemInputSchema = z.strictObject({
  actorId: documentIdSchema,
  itemId: documentIdSchema,
});

export const actorSheetOutputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  documentType: z.literal('ActorSheet'),
  actor: actorIdentitySchema,
  system: actorSystemIdentitySchema,
  sections: z.array(actorSectionDescriptorSchema).length(ACTOR_SECTION_NAMES.length),
  itemCount: z.number().int().nonnegative(),
  readMetadata: availableWorldReadMetadataSchema,
});

export const actorSectionOutputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  documentType: z.literal('ActorSection'),
  actor: actorIdentitySchema,
  system: actorSystemIdentitySchema,
  section: actorSectionNameSchema,
  supported: z.boolean(),
  fields: z.array(actorFieldSchema).max(64),
  readMetadata: availableWorldReadMetadataSchema,
});

export const actorItemSummarySchema = z.strictObject({
  id: documentIdSchema,
  uuid: z.string().regex(/^Actor\.[a-zA-Z0-9]{16}\.Item\.[a-zA-Z0-9]{16}$/),
  name: z.string().max(512),
  type: z.string().max(128),
  img: z.string().max(2048).optional(),
  quantity: z.number().finite().optional(),
  equipped: z.boolean().optional(),
});

export const actorItemListOutputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  documentType: z.literal('ActorItemCollection'),
  actor: actorIdentitySchema,
  records: z.array(actorItemSummarySchema).max(100),
  ...paginationShape,
});

export const actorOwnedItemSchema = z.strictObject({
  id: documentIdSchema,
  uuid: z.string().regex(/^Actor\.[a-zA-Z0-9]{16}\.Item\.[a-zA-Z0-9]{16}$/),
  parentActorId: documentIdSchema,
  name: z.string().max(512),
  type: z.string().max(128),
  img: z.string().max(2048).optional(),
  quantity: z.number().finite().optional(),
  equipped: z.boolean().optional(),
  fields: z.array(actorFieldSchema).max(64),
  systemFieldsSupported: z.boolean(),
});

export const actorItemOutputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  documentType: z.literal('ActorItem'),
  actor: actorIdentitySchema,
  item: actorOwnedItemSchema,
  readMetadata: availableWorldReadMetadataSchema,
});

export const actorSheetInputJsonSchema = z.toJSONSchema(actorSheetInputSchema, {
  target: 'draft-7',
});
export const actorSectionInputJsonSchema = z.toJSONSchema(actorSectionInputSchema, {
  target: 'draft-7',
});
export const actorItemListInputJsonSchema = z.toJSONSchema(actorItemListInputSchema, {
  target: 'draft-7',
});
export const actorItemInputJsonSchema = z.toJSONSchema(actorItemInputSchema, {
  target: 'draft-7',
});
export const actorSheetOutputJsonSchema = z.toJSONSchema(actorSheetOutputSchema, {
  target: 'draft-7',
});
export const actorSectionOutputJsonSchema = z.toJSONSchema(actorSectionOutputSchema, {
  target: 'draft-7',
});
export const actorItemListOutputJsonSchema = z.toJSONSchema(actorItemListOutputSchema, {
  target: 'draft-7',
});
export const actorItemOutputJsonSchema = z.toJSONSchema(actorItemOutputSchema, {
  target: 'draft-7',
});

export type ActorIdentity = z.infer<typeof actorIdentitySchema>;
export type ActorSystemIdentity = z.infer<typeof actorSystemIdentitySchema>;
export type ActorField = z.infer<typeof actorFieldSchema>;
export type ActorSheetOutput = z.infer<typeof actorSheetOutputSchema>;
export type ActorSectionOutput = z.infer<typeof actorSectionOutputSchema>;
export type ActorItemSummary = z.infer<typeof actorItemSummarySchema>;
export type ActorItemListOutput = z.infer<typeof actorItemListOutputSchema>;
export type ActorItemOutput = z.infer<typeof actorItemOutputSchema>;
