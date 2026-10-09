/**
 * Resource definitions for FoundryVTT MCP Server
 */

export const resourceDefinitions = [
  {
    uri: 'foundry://actors',
    name: 'All Actors',
    description:
      'First bounded page of world actors; follow nextUri until complete (default 100, maximum 100)',
    mimeType: 'application/json',
  },
  {
    uri: 'foundry://items',
    name: 'All Items',
    description:
      'First bounded page of world items; follow nextUri until complete (default 100, maximum 100)',
    mimeType: 'application/json',
  },
  {
    uri: 'foundry://scenes',
    name: 'All Scenes',
    description:
      'First bounded page of world scenes; follow nextUri until complete (default 100, maximum 100)',
    mimeType: 'application/json',
  },
  {
    uri: 'foundry://scenes/current',
    name: 'Current Scene',
    description: 'Information about the currently active scene',
    mimeType: 'application/json',
  },
  {
    uri: 'foundry://journals',
    name: 'All Journals',
    description:
      'First bounded page of world journals; follow nextUri until complete (default 100, maximum 100)',
    mimeType: 'application/json',
  },
  {
    uri: 'foundry://users',
    name: 'Users',
    description:
      'First bounded page of user metadata; follow nextUri until complete (default 100, maximum 100)',
    mimeType: 'application/json',
  },
  {
    uri: 'foundry://combat',
    name: 'Active Combat',
    description: 'Current active combat encounter state',
    mimeType: 'application/json',
  },
  {
    uri: 'foundry://world/settings',
    name: 'Game Settings',
    description: 'Current world and game system settings',
    mimeType: 'application/json',
  },
  {
    uri: 'foundry://system/diagnostics',
    name: 'System Diagnostics',
    description: 'System health and diagnostic information (requires REST API module)',
    mimeType: 'application/json',
  },
];

export function getAllResources() {
  return resourceDefinitions;
}

export function getAllResourceTemplates() {
  return ['actors', 'items', 'scenes', 'journals', 'users'].map((collection) => ({
    uriTemplate: `foundry://${collection}{?limit,cursor}`,
    name: `${collection} pages`,
    description:
      'Version 2 snapshot pages with stable IDs, total, returnedCount, complete, nextCursor and nextUri. Limit 1–100; cursors expire after five minutes. Socket requires a GM; REST supports actors/items only.',
    mimeType: 'application/json',
  }));
}
