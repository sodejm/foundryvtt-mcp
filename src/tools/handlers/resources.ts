/**
 * Resource access handlers
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { DiagnosticsClient } from '../../diagnostics/client.js';
import type { FoundryClient } from '../../foundry/client.js';
import type { PaginationParams } from '../../foundry/pagination.js';
import {
  actorReadRecord,
  boundedReadResponse,
  collectionRecordSchema,
  itemReadRecord,
  paginationSchema,
  parseReadInput,
  resourcePageInputSchema,
} from '../../foundry/read-contract.js';
import { logger } from '../../utils/logger.js';
import { assertResourceAllowed } from '../authorization.js';
import { getTurnOrder } from './combat-order.js';
import { availableReadMetadata, withToolError } from './utils.js';

export async function handleReadResource(
  uri: string,
  foundryClient: FoundryClient,
  diagnosticsClient: DiagnosticsClient,
) {
  assertResourceAllowed(uri, foundryClient);
  return withToolError(
    'read resource',
    async () => {
      const collection = parseCollectionUri(uri);
      if (collection) {
        return getCollectionResource(uri, collection.name, collection.params, foundryClient);
      }
      switch (uri) {
        case 'foundry://scenes/current':
          return await getCurrentSceneResource(foundryClient);

        case 'foundry://world/settings':
          return await getWorldSettingsResource(foundryClient);

        case 'foundry://combat':
          return await getCombatResource(foundryClient);

        case 'foundry://system/diagnostics':
          return await getSystemDiagnosticsResource(diagnosticsClient);

        default:
          throw new McpError(ErrorCode.InvalidParams, `Unknown resource URI: ${uri}`);
      }
    },
    foundryClient,
  );
}

type CollectionName = 'actors' | 'items' | 'scenes' | 'journals' | 'users';
const collectionNames = new Set<string>(['actors', 'items', 'scenes', 'journals', 'users']);
function parseCollectionUri(
  uri: string,
): { name: CollectionName; params: PaginationParams } | undefined {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid resource URI');
  }
  if (url.protocol !== 'foundry:' || !collectionNames.has(url.hostname) || url.pathname !== '') {
    return undefined;
  }
  if (url.hash || url.username || url.password || url.port) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid collection resource URI');
  }
  const params: Record<string, unknown> = {};
  for (const [key, value] of url.searchParams) {
    if ((key !== 'limit' && key !== 'cursor') || key in params) {
      throw new McpError(ErrorCode.InvalidParams, 'Unknown or duplicate pagination parameter');
    }
    if (key === 'limit') {
      if (!/^[1-9][0-9]*$/.test(value)) {
        throw new McpError(ErrorCode.InvalidParams, 'limit must be an integer between 1 and 100');
      }
      params.limit = Number(value);
    } else {
      params.cursor = value;
    }
  }
  const parsed = parseReadInput(resourcePageInputSchema, params);
  return {
    name: url.hostname as CollectionName,
    params: {
      ...(parsed.limit !== undefined && { limit: parsed.limit }),
      ...(parsed.cursor !== undefined && { cursor: parsed.cursor }),
    },
  };
}
async function getCollectionResource(
  uri: string,
  collection: CollectionName,
  params: PaginationParams,
  client: FoundryClient,
) {
  let records: unknown[];
  let metadata: ReturnType<typeof paginationSchema.parse>;
  const paging = {
    ...params,
    ...(params.cursor === undefined && params.limit === undefined && { limit: 100 }),
  };
  if (collection === 'actors') {
    const page = await client.searchActors(paging);
    records = page.actors.map(actorReadRecord);
    metadata = paginationSchema.parse(page);
  } else if (collection === 'items') {
    const page = await client.searchItems(paging);
    records = page.items.map(itemReadRecord);
    metadata = paginationSchema.parse(page);
  } else {
    const page = await client.getCollectionPage(collection, paging);
    records = page.records.map((record) => collectionRecordSchema.parse(record));
    metadata = paginationSchema.parse(page);
  }
  const nextUri =
    metadata.nextCursor === null
      ? null
      : `foundry://${collection}?limit=${metadata.limit}&cursor=${encodeURIComponent(metadata.nextCursor)}`;
  const text = JSON.stringify({ schemaVersion: 3, collection, records, ...metadata, nextUri });
  return boundedReadResponse({ contents: [{ uri, mimeType: 'application/json', text }] });
}

function worldResource(uri: string, data: Record<string, unknown>, client: FoundryClient) {
  const readMetadata = availableReadMetadata(client);
  return {
    contents: [
      { uri, mimeType: 'application/json', text: JSON.stringify({ ...data, readMetadata }) },
    ],
  };
}

async function getCurrentSceneResource(foundryClient: FoundryClient) {
  let currentScene: Awaited<ReturnType<FoundryClient['getCurrentScene']>>;
  try {
    currentScene = await foundryClient.getCurrentScene();
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'No active scene') {
      throw error;
    }
    return worldResource(
      'foundry://scenes/current',
      {
        currentScene: null,
        message: 'No active scene',
      },
      foundryClient,
    );
  }
  return worldResource('foundry://scenes/current', { currentScene }, foundryClient);
}

async function getWorldSettingsResource(foundryClient: FoundryClient) {
  const world = await foundryClient.getWorldInfo();
  return worldResource('foundry://world/settings', { world }, foundryClient);
}

/**
 * Serves the active combat encounter (#214 follow-up).
 *
 * `Combat#turn` indexes the **initiative-sorted** turn order, and this resource
 * is the id-bearing companion to `get_combat_state`, whose ordinals are printed
 * in that same order. Emitting the raw cached `combatants` array — which is in
 * creation order — next to that `turn` makes both `combat.combatants[turn]` and
 * "the Nth combatant I just read" resolve to the wrong document, so the emitted
 * `combatants` are re-ordered here through the shared `getTurnOrder()` helper.
 *
 * `getTurnOrder()` sorts a copy: the cached array is a live reference into
 * worldData and must not be reordered as a side effect of a read.
 */
async function getCombatResource(foundryClient: FoundryClient) {
  const cached = foundryClient.getCombatState();
  const combat = cached ? { ...cached, combatants: getTurnOrder(cached) } : cached;
  return worldResource('foundry://combat', { combat }, foundryClient);
}

async function getSystemDiagnosticsResource(diagnosticsClient: DiagnosticsClient) {
  try {
    const health = await diagnosticsClient.getSystemHealth();
    return {
      contents: [
        {
          uri: 'foundry://system/diagnostics',
          mimeType: 'application/json',
          text: JSON.stringify(
            {
              systemHealth: health,
              source: 'rest',
              freshness: 'current',
              capturedAt: health.timestamp,
              observedAt: new Date().toISOString(),
              respondedAt: new Date().toISOString(),
            },
            null,
            2,
          ),
        },
      ],
    };
  } catch (error) {
    logger.debug('getSystemDiagnosticsResource: diagnostics unavailable', { error });
    return {
      contents: [
        {
          uri: 'foundry://system/diagnostics',
          mimeType: 'application/json',
          text: JSON.stringify(
            {
              message: 'Diagnostics require REST API module',
              source: 'rest',
              freshness: 'unavailable',
              capturedAt: null,
              observedAt: null,
              respondedAt: new Date().toISOString(),
            },
            null,
            2,
          ),
        },
      ],
    };
  }
}
