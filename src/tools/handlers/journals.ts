/**
 * Journal entry tool handlers
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { FoundryClient } from '../../foundry/client.js';
import {
  boundedReadResponse,
  collectionSearchSchema,
  paginationText,
  parseReadInput,
  worldSearchInputSchema,
} from '../../foundry/read-contract.js';
import { withToolError, withWorldRead } from './utils.js';

export async function handleSearchJournals(
  args: { query?: string; limit?: number; cursor?: string },
  foundryClient: FoundryClient,
) {
  const params = parseReadInput(worldSearchInputSchema, args);
  return withToolError('search journals', async () => {
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
  });
}

export async function handleGetJournal(args: { journalId: string }, foundryClient: FoundryClient) {
  return withWorldRead('get journal', foundryClient, async () => {
    const journal = foundryClient.getJournal(args.journalId);

    if (!journal) {
      throw new McpError(ErrorCode.InvalidParams, `Journal not found: ${args.journalId}`);
    }

    const pages =
      journal.pages
        ?.map((p) => {
          const content =
            p.text?.content
              ?.replace(/<[^>]+>/g, '')
              .trim()
              .slice(0, 500) || '';
          return `### ${p.name}\n${content}${content.length >= 500 ? '...' : ''}`;
        })
        .join('\n\n') || 'No pages.';

    return {
      content: [
        {
          type: 'text',
          text: `**Journal: ${journal.name}**\nID: ${journal._id}\n\n${pages}`,
        },
      ],
    };
  });
}
