/** Optional Foundry integration capability and compendium handlers. */
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { FoundryClient } from '../../foundry/client.js';
import {
  capabilitiesInputSchema,
  capabilitiesReportSchema,
  compendiumSearchInputSchema,
  compendiumSearchSchema,
} from '../../foundry/compendium-contract.js';
import { PaginationCursorError } from '../../foundry/pagination.js';
import {
  boundedReadResponse,
  paginationText,
  parseReadInput,
} from '../../foundry/read-contract.js';
import type { CompendiumSearchResult } from '../../foundry/types.js';
import { withToolError } from './utils.js';

export async function handleSearchCompendium(args: unknown, client: FoundryClient) {
  const { query, filters, limit, cursor } = parseReadInput(compendiumSearchInputSchema, args);
  return withToolError(
    'search compendium',
    async () => {
      let response: CompendiumSearchResult;
      try {
        response = await client.searchCompendium({
          query,
          ...filters,
          ...(limit !== undefined && { limit }),
          ...(cursor !== undefined && { cursor }),
        });
      } catch (error) {
        if (error instanceof PaginationCursorError) {
          throw new McpError(ErrorCode.InvalidParams, error.message);
        }
        throw error;
      }
      const structuredContent = compendiumSearchSchema.parse(response);
      const capability = structuredContent.capability;
      const text = structuredContent.restAvailable
        ? `📚 **Compendium Search Results**
**Query:** ${query}
**Capability:** ${capability.status}
**Results:** ${structuredContent.results.length}/${structuredContent.total} total

${structuredContent.results.map((entry) => `- **${entry.name}** (${entry.type}) — pack: ${entry.compendiumId}, id: ${entry.itemId}${entry.system?.level !== undefined ? `, level ${entry.system.level}` : ''}${entry.system?.source?.rules ? `, rules: ${entry.system.source.rules}` : ''}`).join('\n') || 'No compendium entries found matching the criteria.'}

${paginationText(structuredContent)}`
        : `**Compendium search: ${capability.status}**
${capability.reason}
${capability.remediation ?? ''}
Results are unavailable.`;
      return boundedReadResponse({ structuredContent, content: [{ type: 'text' as const, text }] });
    },
    client,
  );
}

export async function handleGetCapabilities(args: unknown, client: FoundryClient) {
  parseReadInput(capabilitiesInputSchema, args);
  return withToolError(
    'get capabilities',
    async () => {
      const structuredContent = capabilitiesReportSchema.parse(await client.getCapabilities());
      return {
        structuredContent,
        content: [
          {
            type: 'text' as const,
            text: structuredContent.capabilities
              .map(
                (capability) =>
                  `**${capability.feature}: ${capability.status}** — ${capability.reason}${capability.remediation ? ` ${capability.remediation}` : ''}`,
              )
              .join('\n'),
          },
        ],
      };
    },
    client,
  );
}
