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

For optional compendium search, add the paired relay configuration to the `env` block:

```json
{
  "FOUNDRY_REST_URL": "http://127.0.0.1:3010",
  "FOUNDRY_REST_CLIENT_ID": "your_relay_client_id",
  "FOUNDRY_REST_API_KEY": "your_scoped_relay_key"
}
```

Call `get_capabilities` before relying on optional support. See the
[optional capability guide](optional-capabilities.md) for module setup, key scopes
and unavailable results.

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
alongside version 3 search `structuredContent`. For example, a search can return two
actors with the same name:

```json
{
  "schemaVersion": 3,
  "documentType": "Actor",
  "records": [
    {"id": "Actor00000000001", "documentType": "Actor", "name": "Goblin", "type": "npc", "hp": {"value": 0, "max": 7}},
    {"id": "Actor00000000002", "documentType": "Actor", "name": "Goblin", "type": "npc"}
  ],
  "total": 2,
  "page": 1,
  "limit": 10,
  "returnedCount": 2,
  "nextCursor": null,
  "complete": true,
  "snapshotId": "opaque-snapshot-id",
  "expiresAt": "2026-10-09T03:00:00.000Z",
  "consistency": "snapshot",
  "readMetadata": {
    "source": "socket",
    "freshness": "current",
    "worldId": "example-world",
    "sessionId": "opaque-session-id",
    "snapshotId": "opaque-source-snapshot-id",
    "revision": 1,
    "capturedAt": "2026-10-09T02:55:00.000Z",
    "observedAt": "2026-10-09T02:55:00.000Z",
    "respondedAt": "2026-10-09T02:55:01.000Z"
  }
}
```

Choose the record by `id` and call `get_actor_details` with
`{"actorId":"Actor00000000002"}`. The detail response has
`{"schemaVersion":2,"documentType":"Actor","record":{...},"readMetadata":{...}}` and verifies that
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
error. Service-identity reads may retain cached data after transport loss with `freshness: "stale"`; pagination
cursors are invalidated by disconnect/reconnect. REST modules must implement
`/api/items/:id` for item details; unsupported routes produce their backend
error. This adds no fallback to owned items or compendiums. Socket pagination
requires a GM session in service-identity mode. Delegated socket reads instead
require trusted caller context and a fresh permission-filtered view. REST
pagination uses only the authenticated backend's visible collection.

The text block remains available for existing MCP consumers. Prefer the typed
`structuredContent` fields and validate against the advertised output schema;
detail version 2 retains existing mapped system fields without promising a complete
actor sheet, inventory or cross-system normalization.

### Traversing bounded searches and resources

All four world searches (`search_actors`, `search_items`, `search_journals`,
`search_world`) return a version 3 page. Start with a query and optional limit,
then pass `nextCursor` back to the same tool with the same query, filters and
limit. Stop at `nextCursor: null` / `complete: true`. Search limits default to
10 and cannot exceed 100. Numeric page input and unknown parameters are rejected
with `InvalidParams`. Query/cursor strings allow at most 1024 characters and
type/rarity selectors 128; empty cursors are invalid.

The server sorts by NFKC-normalized, lowercased name, document type and finally
case-sensitive document ID. Pages share an immutable snapshot with an exact
`total`, `snapshotId` and five-minute `expiresAt`. In service-identity mode, writes
during a traversal do not change its records. Delegated reads revalidate the
authorized view on every continuation and invalidate the cursor when it changes.
Start without a cursor to read the latest view.
Corrupt, expired, evicted or context-mismatched cursors fail; start a new
traversal after reconnecting or changing worlds, callers, queries or filters.
The server retains at most 32 snapshots per client within an aggregate 8 MiB
cache budget. Each snapshot is capped at 10,000 records and 8 MiB. It never
silently truncates an oversized snapshot.

Collection resources (`foundry://actors`, `items`, `scenes`, `journals`, `users`)
now return `{schemaVersion: 3, collection, records, ...pagination, nextUri}`.
Start at, for example, `foundry://actors?limit=25` and follow `nextUri` until null.
The five `resources/templates/list` entries advertise `{?limit,cursor}`.
Delegated discovery includes only actors, items, journals and users, with four
templates; other resources are denied even if requested directly.
Resource limits default to 100, with the same maximum of 100. Old consumers
must switch from unbounded arrays to `records` and continuation links. Singleton
resources, such as `foundry://scenes/current`, retain existing fields and add
`readMetadata`.
Journal/world searches and non-actor/item resources contain metadata and stable
IDs rather than full document bodies.

The final MCP response, including text and JSON, cannot exceed 128 KiB. If a
page is too large, reduce the limit; no partial page is returned. REST actor/item
adapters fetch every backend page and reject repeated/non-progressing pages or
inconsistent totals. REST journal/world searches and scene/journal/user pages
remain unsupported and fail explicitly.

### Bounded actor sheets and owned items

`get_actor_sheet`, `get_actor_section`, `list_actor_items` and `get_actor_item`
return schema version 1, with advertised output schemas and matching JSON in
`content[0].text` and `structuredContent`. Import the corresponding
`actorSheetOutputSchema`, `actorSectionOutputSchema`, `actorItemListOutputSchema`
and `actorItemOutputSchema` from `foundry/actor-sheet-contract`.
The existing version 2 `get_actor_details` summary remains compatible.

`get_actor_sheet` takes `actorId` and returns actor identity, `system` ID/version
and profile, visible `itemCount`, and descriptors for seven sections:
`attributes`, `abilities`, `skills`, `details`, `currency`, `resources` and
`system`. Each descriptor reports `supported` and `fieldCount`.
`get_actor_section` takes that actor ID and a section name. A field has `key`,
`label`, `source: "normalized" | "system-path"`, optional source `path`,
`present`, optional scalar `value` and optional `truncated`. Missing values have
`present: false` with no invented default; zero, false, null and empty text can
be real values. Unsupported sections explicitly return `supported: false` and
an empty field list.

DND5e profiles map HP/AC, abilities, skills, details, currency and resources;
PF2e profiles map their distinct paths for modifiers, ancestry/class details,
hero points and conditions. Both expose six normalized sections and leave the
generic `system` section unsupported. Synthetic unit/workflow fixtures carry
DND5e 6.0.6 and PF2e 6.2.0 version metadata and exercise different level paths
(`details.level` and `details.level.value`). Live validation uses DND5e 6.0.6;
PF2e has not been validated against a running system. The synthetic fixtures
establish field mappings and version propagation, not release compatibility.
For unknown systems, service-identity mode provides only a
bounded primitive system-path section and bounded owned-item identity.
Delegated unknown-system reads are rejected.

Sections and item details contain at most 64 fields. A text field allows at
most 4,096 UTF-16 code units and all field text shares an 8,192-unit budget.
Names are clipped to 512 units. Clipping preserves Unicode surrogate pairs;
field truncation is explicit. Generic traversal visits at most 256 nodes at
depth four and omits arrays, nested document bodies and sensitive paths such
as credentials, ownership, flags and tokens. Delegated known-system reads
check actor/embedded-document permissions first and omit rich descriptions
and biographies because those fields lack a verified field-visibility contract.
All combined MCP responses retain the 128 KiB limit.

`list_actor_items` takes `actorId`, optional `query`, `type`, `limit` and
`cursor`. Limits default to 10 and allow 1–100; queries/cursors allow at most
1,024 characters and types 128. IDs must be 16 alphanumeric characters.
The response includes parent actor context, item records with stable IDs and
verified embedded UUIDs, and shared pagination/freshness fields. Select by ID
even when names repeat, then fetch detail with both parent and item IDs:

```ts
const ownedItems = [];
let cursor: string | undefined;
do {
  const result = await client.callTool({
    name: 'list_actor_items',
    arguments: { actorId, limit: 10, ...(cursor ? { cursor } : {}) },
  });
  const page = actorItemListOutputSchema.parse(result.structuredContent);
  ownedItems.push(...page.records);
  cursor = page.nextCursor ?? undefined;
} while (cursor);

const selected = ownedItems[0];
if (selected) {
  const result = await client.callTool({
    name: 'get_actor_item',
    arguments: { actorId, itemId: selected.id },
  });
  const detail = actorItemOutputSchema.parse(result.structuredContent);
  console.log(detail.item.parentActorId, detail.item.fields);
}
```

An item ID from another actor cannot resolve under the requested parent.
Empty inventory returns a successful complete page. Keep actor, query, type
and limit unchanged on continuation. Cursors expire after five minutes, bind
to world/caller/session, and invalidate after inventory content, order or
visibility changes in both modes. Restart from the first page after edits,
deletions, reconnects or permission changes. Native Socket.IO is required;
REST explicitly reports unsupported reads.

`tests/integration/actor-sheet.integration.test.ts` exercises the built MCP
stdio server against disposable DND5e `test1world`. Start
`node scripts/actor-test-control.mjs` with explicit `FOUNDRY_URL`,
`FOUNDRY_USERNAME` and `FOUNDRY_PASSWORD` outside source. The controller binds
to `127.0.0.1:3013`, requires that world/system and a GM browser, and creates,
updates or removes only actors named with the prefix `MCP Actor Issue 7`.
Set `FOUNDRY_ACTOR_TEST_CONTROL_URL=http://127.0.0.1:3013`, then run:

```sh
npm run build
npm run test:integration -- tests/integration/actor-sheet.integration.test.ts
```

The suite covers empty/251-item inventories, duplicate and Unicode names,
zero values, missing fields, long descriptions, exact ID composition,
schema/response bounds, filter/cursor isolation, and post-edit/sort/delete
reads. Caller-permission integration separately verifies observer grants,
hidden parents/items, redaction and immediate revocation using Foundry's
native permission oracle. Missing prerequisites fail instead of skipping.

### Complete journal pages

Journal summaries and page content have separate contracts. `get_journal`
returns schema version 3 with `pages` and the shared pagination fields; existing
consumers must follow `nextCursor` to list every page. Previews are limited to
500 Unicode code points and carry `contentTruncated`. Page IDs and verified
UUIDs, type, sort, source format, title and available asset metadata identify the
source document. Summary totals count only visible pages.

`get_journal_page` accepts `journalId`, `pageId`, optional `format: "text" |
"source"`, `limit` and `cursor`. Both tools require 16-character alphanumeric
IDs and reject UUIDs, unknown arguments and empty cursors. Limits default to 4
and allow 1–8; the summary limit counts pages and the content limit counts chunks.
The content response uses schema version 1 and `documentType: "JournalEntryPage"`.
It includes page metadata, the selected format, code-point `contentLength`,
`chunks`, `contentTruncated` and `paginationPage` alongside the shared pagination
and `readMetadata` fields. Each chunk has a zero-based `index` and code-point
`start`/exclusive `end`, with at most 1,024 code points of `content`.

For example, a structured consumer can collect complete text as follows:

```ts
const parts: string[] = [];
let cursor: string | undefined;
do {
  const result = await client.callTool({
    name: 'get_journal_page',
    arguments: { journalId, pageId, format: 'text', limit: 4, ...(cursor ? { cursor } : {}) },
  });
  const page = journalPageContentSchema.parse(result.structuredContent);
  parts.push(...page.chunks.map(chunk => chunk.content));
  cursor = page.nextCursor ?? undefined;
} while (cursor);
const completeText = parts.join('');
```

Import `journalPageContentSchema` from `foundry/journal-contract`. The default
`text` format parses HTML inertly, retains headings/paragraph/list breaks and
decodes entities; Markdown is returned literally. `source` preserves the original
HTML/Markdown string. Returning source never executes it; consumers must handle
it as untrusted content. Empty text returns one empty chunk. Non-text pages
return zero chunks and typed metadata, including visible image/video references.

Content/page-order/ownership changes invalidate cursors for the whole visible
journal in both service-identity and delegated modes. Continuations bind to the
tool, IDs, format, limit, world, caller and session. Their five-minute expiry,
reconnect and permission checks require restarting from the first page after
invalidation. Hidden and absent journal/page IDs yield the same `InvalidParams`
error. Native Socket.IO supports these reads; REST fails explicitly.

Preparation rejects text sources exceeding 4 MiB, HTML trees exceeding 100,000
nodes or 4,096 open elements, or journal snapshots exceeding 10,000 records/8 MiB. The final combined
MCP text/structured response remains limited to 128 KiB. Capacity failures are
explicit and never return silently shortened content.

`tests/integration/journals.integration.test.ts` uses disposable `test1world`
through the built MCP stdio process and compares results with actual source
documents. After `npm run build`, start `node scripts/journal-test-control.mjs`
with explicit `FOUNDRY_URL`, `FOUNDRY_USERNAME` and `FOUNDRY_PASSWORD` in a separate
terminal. The controller binds to `127.0.0.1:3012`, requires `test1world`, and only
creates, changes or removes journals whose names begin `MCP Journal Issue 6`.
Set `FOUNDRY_JOURNAL_TEST_CONTROL_URL=http://127.0.0.1:3012` in the integration
environment, then run:

```sh
npm run test:integration -- tests/integration/journals.integration.test.ts
```

The suite covers 0/499/500/501/10,000+ characters, HTML entities and nesting,
Unicode, Markdown, empty/image/video pages, exact chunk reassembly, summary
ordering, edits/reordering/deletion, cursor isolation, invalid IDs and advertised
output schemas. Caller-permission tests separately compare inherited/explicit
page visibility, content and asset redaction, and revocation with Foundry's
OBSERVER oracle. Missing prerequisites fail; tests do not skip acceptance cases.

### Consuming freshness metadata

Successful service-identity world reads include `readMetadata` with `freshness: "current"` or
`"stale"`. Without a validated source snapshot they return an error. Presence,
chat, combat, scene and summary reads follow the same policy as document reads.
Use `get_health_status` to inspect unavailable cache state; a successful REST
health request does not mark socket data current.

`worldId`, `sessionId`, source `snapshotId` and `revision` identify the data view.
`capturedAt` is source capture time; `observedAt` is local source receipt time;
`respondedAt` is response time. Reading retained data does not refresh its source
clocks. REST responses without a source capture time use null `capturedAt` and
`snapshotId`. Pagination has a separate top-level `snapshotId`: its records and
source metadata remain immutable, and later pages report stale when that source
has advanced.

After a socket outage the client automatically attempts bounded snapshot recovery.
`refresh_world_data` explicitly retries the same recovery mechanism. Concurrent
requests coalesce; retained data stays stale until a complete, validated response
replaces it. Timeouts, malformed responses and obsolete session responses cannot
make stale data current. Consumers should discard cached pages and restart
traversal after world/session changes or invalidated cursor errors.

The default recovery budget is four attempts (one initial attempt plus three
retries), each with a 10-second acknowledgment timeout and a 1-second retry
delay. Configure `timeout`, `retryAttempts` and `retryDelay` on
`FoundryClientConfig` to change this budget. The refresh event buffer is capped
at 1,000 events; overflow fails recovery without publishing a partial snapshot.

Delegated reads require a fresh authoritative socket response for each MCP
request. They never serve retained stale data or use REST to authorize access.
Every continuation rechecks the caller, membership, ownership and source session;
revocation or a changed authorized view invalidates the cursor. See
[delegated caller configuration](configuration.md#delegated-callers) for the host
resolver, supported surfaces and conservative visibility restrictions.

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

`tests/integration/pagination.integration.test.ts` additionally requires the
disposable world ID `test1world`. It creates uniquely named fixtures (251 actors,
251 items, journals and scenes), exercises the built MCP CLI, and deletes only
its own fixtures afterward. It verifies exact traversals, duplicate names,
snapshot consistency under writes, all five resources and invalid inputs.

`tests/integration/caller-permissions.integration.test.ts` creates two temporary
player users and owned documents in disposable `test1world`. It compares GM and
player reads with Foundry's actual OBSERVER checks and each player's chat
`isContentVisible` result through authenticated browser sessions. Its cases
exercise visible/hidden IDs, explicit/default/inherited grants, embedded items,
journal pages, counts, filtering before pagination, cursor isolation, immediate
revocation, forged identities, denied reads/writes, reconnects and membership
loss. It fails on missing prerequisites and cleans up its owned fixtures.
The built MCP resolver workflow also covers absent/throwing host resolvers,
concurrent callers and generic error redaction without trusting request metadata.

`tests/integration/compendium.integration.test.ts` additionally requires a paired
local REST relay, the enabled REST module, an active GM browser controller and
disposable scoped keys. Its 13 cases exercise verified capability reports, wrong
and insufficient-scope keys, socket-only and plain Foundry configurations, actual
empty searches, filters, 1/100/101/251-entry traversals, authorization revocation,
module removal and recovery. Missing prerequisites fail instead of skipping. See
[optional capability configuration and test prerequisites](optional-capabilities.md).
