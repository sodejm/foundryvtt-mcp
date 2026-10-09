/**
 * Shared utilities for tool handlers
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { FoundryClient } from '../../foundry/client.js';
import { worldReadMetadataSchema } from '../../foundry/freshness.js';
import { readMetadataText } from '../../foundry/read-contract.js';
import { logger } from '../../utils/logger.js';

/**
 * Wraps an async handler function with standard error logging and McpError conversion.
 *
 * @param toolName - Label used in error log messages (e.g. 'search actors')
 * @param fn - Async function containing the handler logic
 */
export async function withToolError<T>(toolName: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    logger.error(`Failed to ${toolName}:`, error);
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to ${toolName}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}

/** Reject absent snapshots instead of presenting an unavailable world as empty. */
export function availableReadMetadata(client: FoundryClient) {
  const metadata = worldReadMetadataSchema.parse(client.getReadMetadata());
  if (metadata.freshness === 'unavailable') {
    throw new Error('World data unavailable: wait for snapshot recovery or run refresh_world_data');
  }
  return metadata;
}

/** Add the same freshness contract to cached tools that retain their text response. */
export async function withWorldRead<
  T extends { content: unknown[]; structuredContent?: Record<string, unknown> },
>(toolName: string, client: FoundryClient, fn: () => Promise<T>) {
  return withToolError(toolName, async () => {
    const result = await fn();
    const readMetadata = availableReadMetadata(client);
    return {
      ...result,
      structuredContent: { ...result.structuredContent, readMetadata },
      content: [...result.content, { type: 'text' as const, text: readMetadataText(readMetadata) }],
    };
  });
}
