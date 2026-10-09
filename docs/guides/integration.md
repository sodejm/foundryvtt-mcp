# Integration Guide

## Claude Desktop

Add to your Claude Desktop MCP settings:

```json
{
  "mcpServers": {
    "foundry": {
      "command": "node",
      "args": ["/path/to/foundry-mcp-server/dist/index.js"],
      "env": {
        "FOUNDRY_URL": "http://localhost:30000",
        "FOUNDRY_USERNAME": "your_username",
        "FOUNDRY_PASSWORD": "your_password"
      }
    }
  }
}
```

To enable optional diagnostics tools, add `FOUNDRY_API_KEY` to the `env` block:

```json
{
  "FOUNDRY_API_KEY": "your_api_key_here"
}
```

## Custom MCP Client

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["./dist/index.js"],
});

const client = new Client(
  {
    name: "foundry-client",
    version: "1.0.0",
  },
  {
    capabilities: {},
  },
);

await client.connect(transport);

// Roll dice
const result = await client.request({
  method: "tools/call",
  params: {
    name: "roll_dice",
    arguments: {
      formula: "1d20+5",
      reason: "Initiative roll",
    },
  },
});
```

## Tool Schema Examples

### roll_dice

```json
{
  "formula": "1d20+5",
  "reason": "Attack roll against goblin"
}
```

### search_world

```json
{
  "query": "dragon",
  "limit": 10
}
```

### get_combat_state

```json
{}
```

### search_actors

```json
{
  "query": "goblin",
  "type": "npc",
  "limit": 10
}
```


### Stable actor/item search-to-detail workflow

Actor/item search and detail tools publish an `outputSchema` and retain text
alongside version 1 `structuredContent`. For example, a search can return two
actors with the same name:

```json
{
  "schemaVersion": 1,
  "documentType": "Actor",
  "records": [
    {"id": "Actor00000000001", "documentType": "Actor", "name": "Goblin", "type": "npc", "hp": {"value": 0, "max": 7}},
    {"id": "Actor00000000002", "documentType": "Actor", "name": "Goblin", "type": "npc"}
  ],
  "total": 2,
  "page": 1,
  "limit": 10
}
```

Choose the record by `id` and call `get_actor_details` with
`{"actorId":"Actor00000000002"}`. The detail response has
`{"schemaVersion":1,"documentType":"Actor","record":{...}}` and verifies that
`record.id` equals the requested ID. The item workflow uses `search_items`,
`documentType: "Item"`, and `get_item_details` with `{"itemId":"..."}`. It
reads world items only, excluding actor-owned and compendium items. Example IDs
are placeholders; always use IDs returned by your current search.

Optional fields are omitted when absent. Zero HP or price, false item flags
and empty descriptions are preserved. Do not substitute truthiness defaults.
Only the world-cache source establishes UUID scope; ambiguous REST UUIDs are
omitted. No raw `system` or `data` objects are serialized in this contract.

Detail IDs must be exactly 16 alphanumeric characters. Invalid, empty,
nonstring or path-like IDs fail with MCP `InvalidParams` (`-32602`) before I/O.
Missing/removed documents, unavailable world data/backend, malformed responses
or mismatched returned IDs fail with `InternalError` (`-32603`). An actual empty
world/search returns `records: []`; an unavailable world snapshot returns an
error. A retained snapshot may remain readable after transport loss; this
contract does not guarantee freshness. REST modules must implement
`/api/items/:id` for item details; unsupported routes produce their backend
error. This adds no fallback to owned items or
compendiums and changes no access permissions.

The text block remains available for existing MCP consumers. Prefer the typed
`structuredContent` fields and validate against the advertised output schema;
version 1 retains existing mapped system fields without promising a complete
actor sheet, inventory or cross-system normalization.

Run `npm run test:reads:coverage` for the full unit suite with 100% statement,
branch, function and line coverage enforced for the shared read contract and
actor/item handlers. Run `npm run test:workflow` for the built CLI over real MCP
stdio against a local REST fixture. That fixture proves the process/protocol
workflow; supported Foundry compatibility still requires live integration.

`tests/integration/structured-reads.integration.test.ts` requires a licensed,
bootstrapped world containing exactly two actors with a shared name and exactly
two world items with a shared name. The live test records core/system/module
version evidence. Missing connection or fixture prerequisites fail; they do not
skip. Use the existing integration setup and keep credentials outside source.
