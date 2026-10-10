/**
 * Journal entry tool handlers
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { FoundryClient } from '../../foundry/client.js';
import {
  journalPageContentSchema,
  journalPageInputSchema,
  journalSummaryInputSchema,
  journalSummarySchema,
} from '../../foundry/journal-contract.js';
import { JournalReadUnavailableError } from '../../foundry/journal-read.js';
import { PaginationCursorError } from '../../foundry/pagination.js';
import {
  boundedReadResponse,
  collectionSearchSchema,
  paginationText,
  parseReadInput,
  worldSearchInputSchema,
} from '../../foundry/read-contract.js';
import { withToolError } from './utils.js';

export async function handleSearchJournals(
  args: { query?: string; limit?: number; cursor?: string },
  foundryClient: FoundryClient,
) {
  const params = parseReadInput(worldSearchInputSchema, args);
  return withToolError(
    'search journals',
    async () => {
      const page = await foundryClient.searchJournalsPage(params);
      const structuredContent = collectionSearchSchema.parse({
        schemaVersion: 3,
        scope: 'journals',
        ...page,
      });
      const formatted = structuredContent.records
        .map((record) => `- **${record.name}** (${record.documentType}) — ID: ${record.id}`)
        .join('\n');
      return boundedReadResponse({
        structuredContent,
        content: [
          {
            type: 'text' as const,
            text: `**Journal Search** — "${params.query ?? 'All'}"\n\n${formatted || 'No results found.'}\n\n${paginationText(structuredContent)}`,
          },
        ],
      });
    },
    foundryClient,
  );
}

function journalReadError(error: unknown, client: FoundryClient): never {
  if (error instanceof JournalReadUnavailableError) {
    throw new McpError(ErrorCode.InvalidParams, 'Journal unavailable');
  }
  if (error instanceof PaginationCursorError) {
    throw new McpError(
      ErrorCode.InvalidParams,
      client.isDelegatedMode?.() ? 'Pagination cursor unavailable' : error.message,
    );
  }
  throw error;
}

export async function handleGetJournal(args: unknown, foundryClient: FoundryClient) {
  const params = parseReadInput(journalSummaryInputSchema, args);
  return withToolError(
    'get journal',
    async () => {
      const page = await foundryClient
        .getJournalSummaryPage(params)
        .catch((error: unknown) => journalReadError(error, foundryClient));
      const structuredContent = journalSummarySchema.parse({
        schemaVersion: 3,
        documentType: 'JournalEntry',
        ...page,
      });
      const pages = structuredContent.pages
        .map(
          (entry) =>
            `### ${entry.name}\nID: ${entry.id} | UUID: ${entry.uuid}\nType: ${entry.type} | Source: ${entry.sourceFormat} | Preview truncated: ${entry.contentTruncated}\n${entry.content}${entry.contentTruncated ? '...' : ''}`,
        )
        .join('\n\n');
      return boundedReadResponse({
        structuredContent,
        content: [
          {
            type: 'text' as const,
            text: `**Journal: ${structuredContent.name}**\nID: ${structuredContent.id} | UUID: ${structuredContent.uuid}\n\n${pages || 'No pages.'}\n\n${paginationText(structuredContent)}`,
          },
        ],
      });
    },
    foundryClient,
  );
}

export async function handleGetJournalPage(args: unknown, foundryClient: FoundryClient) {
  const params = parseReadInput(journalPageInputSchema, args);
  return withToolError(
    'get journal page',
    async () => {
      const page = await foundryClient
        .getJournalPageContent(params)
        .catch((error: unknown) => journalReadError(error, foundryClient));
      const structuredContent = journalPageContentSchema.parse({
        schemaVersion: 1,
        documentType: 'JournalEntryPage',
        ...page,
      });
      const chunks = structuredContent.chunks
        .map(
          (chunk) =>
            `**Chunk ${chunk.index} (${chunk.start}–${chunk.end} Unicode code points):**\n${chunk.content}`,
        )
        .join('\n\n');
      return boundedReadResponse({
        structuredContent,
        content: [
          {
            type: 'text' as const,
            text: `**Journal page: ${structuredContent.page.name}**\nJournal ID: ${structuredContent.journalId} | Page ID: ${structuredContent.page.id}\nUUID: ${structuredContent.page.uuid}\nType: ${structuredContent.page.type} | Source: ${structuredContent.page.sourceFormat} | Format: ${structuredContent.format}\n**Content length:** ${structuredContent.contentLength} Unicode code points | **Content truncated:** ${structuredContent.contentTruncated}\n\n${chunks || 'No text content.'}\n\n${paginationText({ ...structuredContent, page: structuredContent.paginationPage })}`,
          },
        ],
      });
    },
    foundryClient,
  );
}
