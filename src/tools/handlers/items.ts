/** World-item search and detail handlers; excludes embedded and compendium items. */
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { FoundryClient } from '../../foundry/client.js';
import {
  documentIdSchema,
  itemDetailsSchema,
  itemReadRecord,
  itemSearchDocumentSchema,
  itemSearchSchema,
} from '../../foundry/read-contract.js';
import { withToolError } from './utils.js';

export async function handleSearchItems(
  args: { query?: string; type?: string; rarity?: string; limit?: number },
  foundryClient: FoundryClient,
) {
  const { query, type, rarity, limit = 10 } = args;
  return withToolError('search items', async () => {
    const searchParams: { query: string; type?: string; rarity?: string; limit: number } = {
      query: query || '',
      limit,
    };
    if (type) {
      searchParams.type = type;
    }
    if (rarity) {
      searchParams.rarity = rarity;
    }
    const result = itemSearchDocumentSchema.parse(await foundryClient.searchItems(searchParams));
    const structuredContent = itemSearchSchema.parse({
      schemaVersion: 1,
      documentType: 'Item',
      records: result.items.map(itemReadRecord),
      total: result.total,
      page: result.page,
      limit: result.limit,
    });
    const itemList = structuredContent.records
      .map((item) => {
        const price = item.price
          ? `${item.price.value} ${item.price.denomination}`
          : 'Unknown price';
        return `- **${item.name}** (${item.type}) - ${item.rarity ?? 'Unknown rarity'} - ${price} - ID: ${item.id}`;
      })
      .join('\n');
    return {
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

**Page:** ${structuredContent.page} | **Limit:** ${structuredContent.limit}`,
        },
      ],
    };
  });
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
  return withToolError('get item details', async () => {
    const item = itemReadRecord(await foundryClient.getItem(itemId));
    if (item.id !== itemId) {
      throw new Error('Item response ID mismatch');
    }
    const structuredContent = itemDetailsSchema.parse({
      schemaVersion: 1,
      documentType: 'Item',
      record: item,
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

**Description:** ${item.description ?? 'No description available.'}`,
        },
      ],
    };
  });
}
