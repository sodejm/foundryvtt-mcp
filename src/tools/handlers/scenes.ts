/**
 * @fileoverview Scene management tool handlers
 *
 * Handles scene information retrieval and management.
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { FoundryClient } from '../../foundry/client.js';
import { PaginationCursorError } from '../../foundry/pagination.js';
import { boundedReadResponse, parseReadInput } from '../../foundry/read-contract.js';
import {
  sceneSpatialInputSchema,
  sceneSpatialOutputSchema,
  sceneTokenInputSchema,
  sceneTokenListInputSchema,
  sceneTokenListOutputSchema,
  sceneTokenOutputSchema,
} from '../../foundry/scene-spatial-contract.js';
import { withToolError, withWorldRead } from './utils.js';

function sceneStructuredResponse<T extends Record<string, unknown>>(structuredContent: T) {
  return boundedReadResponse({
    structuredContent,
    content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }],
  });
}

export async function handleGetSceneSpatial(args: unknown, foundryClient: FoundryClient) {
  const { sceneId } = parseReadInput(sceneSpatialInputSchema, args);
  return withToolError(
    'get scene spatial metadata',
    async () =>
      sceneStructuredResponse(
        sceneSpatialOutputSchema.parse(foundryClient.getSceneSpatial(sceneId)),
      ),
    foundryClient,
  );
}

export async function handleListSceneTokens(args: unknown, foundryClient: FoundryClient) {
  const input = parseReadInput(sceneTokenListInputSchema, args);
  const params = {
    ...(input.sceneId !== undefined ? { sceneId: input.sceneId } : {}),
    ...(input.query !== undefined ? { query: input.query } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
  };
  return withToolError(
    'list scene tokens',
    async () => {
      try {
        return sceneStructuredResponse(
          sceneTokenListOutputSchema.parse(foundryClient.listSceneTokens(params)),
        );
      } catch (error) {
        if (error instanceof PaginationCursorError) {
          throw new McpError(
            ErrorCode.InvalidParams,
            foundryClient.isDelegatedMode?.() ? 'Pagination cursor unavailable' : error.message,
          );
        }
        throw error;
      }
    },
    foundryClient,
  );
}

export async function handleGetSceneToken(args: unknown, foundryClient: FoundryClient) {
  const { sceneId, tokenId } = parseReadInput(sceneTokenInputSchema, args);
  return withToolError(
    'get scene token',
    async () =>
      sceneStructuredResponse(
        sceneTokenOutputSchema.parse(foundryClient.getSceneToken(sceneId, tokenId)),
      ),
    foundryClient,
  );
}

/**
 * Handles scene information requests
 */
export async function handleGetSceneInfo(
  args: {
    sceneId?: string;
  },
  foundryClient: FoundryClient,
) {
  const { sceneId } = args;

  return withWorldRead('get scene info', foundryClient, async () => {
    const scene = await foundryClient.getCurrentScene(sceneId);

    return {
      content: [
        {
          type: 'text',
          text: `🗺️ **Scene Information**
**Name:** ${scene.name}
**ID:** ${scene._id}
**Active:** ${scene.active ? 'Yes' : 'No'}
**Navigation:** ${scene.navigation ? 'Enabled' : 'Disabled'}
**Dimensions:** ${scene.width} x ${scene.height} pixels
**Padding:** ${scene.padding * 100}%
**Global Light:** ${scene.globalLight ? 'Enabled' : 'Disabled'}
**Darkness Level:** ${scene.darkness * 100}%

**Description:** ${scene.description || 'No description available.'}`,
        },
      ],
    };
  });
}
