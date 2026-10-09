import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { ReadSurface } from '../foundry/caller-context.js';
import type { FoundryClient } from '../foundry/client.js';

/** Only surfaces with a verified delegated projection are exposed. */
export const delegatedTools: Readonly<Record<string, ReadSurface>> = Object.freeze({
  search_actors: 'actors',
  get_actor_details: 'actors',
  search_items: 'items',
  get_item_details: 'items',
  search_journals: 'journals',
  get_journal: 'journals',
  get_journal_page: 'journals',
  get_chat_messages: 'chat',
  get_users: 'users',
  search_world: 'search',
  get_world_summary: 'world-summary',
});

const delegatedResources = new Set(['actors', 'items', 'journals', 'users']);

export function isDelegatedResource(uri: string): boolean {
  try {
    const parsed = new URL(uri);
    return (
      parsed.protocol === 'foundry:' &&
      delegatedResources.has(parsed.hostname) &&
      parsed.pathname === '' &&
      !parsed.username &&
      !parsed.password &&
      !parsed.port &&
      !parsed.hash
    );
  } catch {
    return false;
  }
}

export function assertToolAllowed(name: string, client: FoundryClient): void {
  if (!client.isDelegatedMode?.()) {
    return;
  }
  const surface = Object.hasOwn(delegatedTools, name) ? delegatedTools[name] : undefined;
  if (!surface) {
    throw new McpError(ErrorCode.InvalidRequest, 'Tool unavailable in delegated mode');
  }
  client.assertReadSurfaceAllowed(surface);
}

export function assertResourceAllowed(uri: string, client: FoundryClient): void {
  if (!client.isDelegatedMode?.()) {
    return;
  }
  if (!isDelegatedResource(uri)) {
    throw new McpError(ErrorCode.InvalidRequest, 'Resource unavailable in delegated mode');
  }
  client.assertReadSurfaceAllowed(new URL(uri).hostname as ReadSurface);
}
