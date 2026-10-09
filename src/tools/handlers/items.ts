/** World-item search and detail handlers; excludes embedded and compendium items. */
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { FoundryClient } from '../../foundry/client.js';
import {
  boundedReadResponse,
  documentIdSchema,
  itemDetailsSchema,
  itemReadRecord,
  itemSearchDocumentSchema,
  itemSearchInputSchema,
  itemSearchSchema,
  paginationSchema,
  paginationText,
  parseReadInput,
  readMetadataText,
} from '../../foundry/read-contract.js';
import { availableReadMetadata, withToolError } from './utils.js';

export async function handleSearchItems(
  args: { query?: string; type?: string; rarity?: string; limit?: number; cursor?: string },
  foundryClient: FoundryClient,
) {
  const { query, type, rarity, limit, cursor } = parseReadInput(itemSearchInputSchema, args);
  return withToolError(
    'search items',
    async () => {
      const searchParams = {
        query: query ?? '',
        ...(limit !== undefined && { limit }),
        ...(cursor !== undefined && { cursor }),
        ...(type !== undefined && { type }),
        ...(rarity !== undefined && { rarity }),
      };
      const result = itemSearchDocumentSchema.parse(await foundryClient.searchItems(searchParams));
      const structuredContent = itemSearchSchema.parse({
        schemaVersion: 3,
        documentType: 'Item',
        records: result.items.map(itemReadRecord),
        ...paginationSchema.parse(result),
      });
      const itemList = structuredContent.records
        .map((item) => {
          const price = item.price
            ? `${item.price.value} ${item.price.denomination}`
            : 'Unknown price';
          return `- **${item.name}** (${item.type}) - ${item.rarity ?? 'Unknown rarity'} - ${price} - ID: ${item.id}`;
        })
        .join('\n');
      return boundedReadResponse({
        structuredContent,
        content: [
          {
            type: 'text' as const,
            text: `⚔️ **Item Search Results**
**Query:** ${query || 'All items'}
**Type Filter:** ${type || 'All types'}
**Rarity Filter:** ${rarity || 'All rarities'}
**Results:** ${structuredContent.records.length}/${structuredContent.total} total

${itemList || 'No items found matching the criteria.'}

${paginationText(structuredContent)}`,
          },
        ],
      });
    },
    foundryClient,
  );
}

/** Detail IDs refer only to the same world-item collection used by search_items. */
export async function handleGetItemDetails(args: { itemId: string }, foundryClient: FoundryClient) {
  const { itemId } = args;
  if (!documentIdSchema.safeParse(itemId).success) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Invalid itemId: expected 16 alphanumeric characters',
    );
  }
  return withToolError(
    'get item details',
    async () => {
      const item = itemReadRecord(await foundryClient.getItem(itemId));
      if (item.id !== itemId) {
        throw new Error('Item response ID mismatch');
      }
      const structuredContent = itemDetailsSchema.parse({
        schemaVersion: 2,
        documentType: 'Item',
        record: item,
        readMetadata: availableReadMetadata(foundryClient),
      });
      const price = item.price ? `${item.price.value} ${item.price.denomination}` : 'Unknown price';
      return {
        structuredContent,
        content: [
          {
            type: 'text' as const,
            text: `⚔️ **Item Details: ${item.name}**
**ID:** ${item.id}
**Type:** ${item.type}
**Rarity:** ${item.rarity ?? 'Unknown rarity'}
**Price:** ${price}
**Weight:** ${item.weight ?? 'Unknown'}
**Quantity:** ${item.quantity ?? 'Unknown'}
**Equipped:** ${item.equipped ?? 'Unknown'}
**Identified:** ${item.identified ?? 'Unknown'}

**Description:** ${item.description ?? 'No description available.'}\n\n${readMetadataText(structuredContent.readMetadata)}`,
          },
        ],
      };
    },
    foundryClient,
  );
}
