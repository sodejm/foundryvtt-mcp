/** Public contracts for bounded journal summaries and complete page content. */
import { z } from 'zod';
import { documentIdSchema, paginationShape } from './read-contract.js';

const requestPage = {
  limit: z.number().int().min(1).max(8).optional(),
  cursor: z.string().min(1).max(1024).optional(),
};
export const journalSummaryInputSchema = z.strictObject({
  journalId: documentIdSchema,
  ...requestPage,
});
export const journalPageInputSchema = z.strictObject({
  journalId: documentIdSchema,
  pageId: documentIdSchema,
  format: z.enum(['text', 'source']).optional(),
  ...requestPage,
});

// String maxima allow two UTF-16 units per Unicode code point. The reader enforces
// code-point limits before these public validators enforce the wire shape.
const pageMetadata = {
  id: documentIdSchema,
  uuid: z.string().regex(/^JournalEntry\.[a-zA-Z0-9]{16}\.JournalEntryPage\.[a-zA-Z0-9]{16}$/),
  name: z.string().max(2048),
  type: z.string().max(256),
  sort: z.number(),
  sourceFormat: z.enum(['html', 'markdown', 'unknown', 'none']),
  title: z.strictObject({ show: z.boolean(), level: z.number().int().min(1).max(6) }).optional(),
  asset: z
    .strictObject({ src: z.string().max(16384), caption: z.string().max(8192).optional() })
    .optional(),
};
export const journalPageMetadataSchema = z.strictObject(pageMetadata);
export const journalPageSummarySchema = z.strictObject({
  ...pageMetadata,
  content: z.string().max(1000),
  contentTruncated: z.boolean(),
});
const boundedPagination = {
  ...paginationShape,
  limit: z.number().int().min(1).max(8),
  returnedCount: z.number().int().min(0).max(8),
};
const { page: _paginationPage, ...contentPagination } = boundedPagination;
export const journalSummarySchema = z.strictObject({
  schemaVersion: z.literal(3),
  documentType: z.literal('JournalEntry'),
  id: documentIdSchema,
  uuid: z.string().regex(/^JournalEntry\.[a-zA-Z0-9]{16}$/),
  name: z.string().max(2048),
  pages: z.array(journalPageSummarySchema).max(8),
  ...boundedPagination,
});
export const journalPageContentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  documentType: z.literal('JournalEntryPage'),
  journalId: documentIdSchema,
  page: journalPageMetadataSchema,
  format: z.enum(['text', 'source']),
  contentLength: z.number().int().nonnegative(),
  chunks: z
    .array(
      z.strictObject({
        index: z.number().int().nonnegative(),
        start: z.number().int().nonnegative(),
        end: z.number().int().nonnegative(),
        content: z.string().max(2048),
      }),
    )
    .max(8),
  contentTruncated: z.boolean(),
  ...contentPagination,
  paginationPage: z.number().int().positive(),
});
export const journalSummaryInputJsonSchema = z.toJSONSchema(journalSummaryInputSchema, {
  target: 'draft-7',
});
export const journalPageInputJsonSchema = z.toJSONSchema(journalPageInputSchema, {
  target: 'draft-7',
});
export const journalSummaryOutputSchema = z.toJSONSchema(journalSummarySchema, {
  target: 'draft-7',
});
export const journalPageOutputSchema = z.toJSONSchema(journalPageContentSchema, {
  target: 'draft-7',
});
