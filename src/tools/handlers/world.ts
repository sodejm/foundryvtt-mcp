/**
 * World-level tool handlers: cross-collection search, summary, refresh
 */

import type { FoundryClient } from '../../foundry/client.js';
import {
  boundedReadResponse,
  collectionSearchSchema,
  paginationText,
  parseReadInput,
  worldSearchInputSchema,
} from '../../foundry/read-contract.js';
import { withToolError, withWorldRead } from './utils.js';

export async function handleSearchWorld(
  args: { query?: string; limit?: number; cursor?: string },
  foundryClient: FoundryClient,
) {
  const params = parseReadInput(worldSearchInputSchema, args);
  return withToolError('search world', async () => {
    const page = await foundryClient.searchWorldPage(params);
    const structuredContent = collectionSearchSchema.parse({
      schemaVersion: 3,
      scope: 'world',
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
          text: `**World Search** — "${params.query ?? 'All'}"\n\n${formatted || 'No results found.'}\n\n${paginationText(structuredContent)}`,
        },
      ],
    });
  });
}

export async function handleGetWorldSummary(
  _args: Record<string, unknown>,
  foundryClient: FoundryClient,
) {
  return withWorldRead('get world summary', foundryClient, async () => {
    const worldInfo = await foundryClient.getWorldInfo();
    const counts = foundryClient.getWorldSummary();

    const countLines = Object.entries(counts)
      .map(([key, count]) => `- **${key}**: ${count}`)
      .join('\n');

    return {
      content: [
        {
          type: 'text',
          text: `**World: ${worldInfo.title}**
**System:** ${worldInfo.system} (${worldInfo.systemVersion})
**Core Version:** ${worldInfo.coreVersion}

**Collection Counts:**
${countLines || 'No data available — not connected.'}`,
        },
      ],
    };
  });
}

export async function handleRefreshWorldData(
  _args: Record<string, unknown>,
  foundryClient: FoundryClient,
) {
  return withWorldRead('refresh world data', foundryClient, async () => {
    await foundryClient.refreshWorldData();
    const counts = foundryClient.getWorldSummary();

    const countLines = Object.entries(counts)
      .map(([key, count]) => `- **${key}**: ${count}`)
      .join('\n');

    return {
      content: [
        {
          type: 'text',
          text: `World data refreshed successfully.\n\n**Collection Counts:**\n${countLines}`,
        },
      ],
    };
  });
}
