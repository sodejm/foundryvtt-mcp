# FoundryVTT MCP Server

[![npm version](https://img.shields.io/npm/v/foundryvtt-mcp)](https://www.npmjs.com/package/foundryvtt-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server that integrates with FoundryVTT, allowing AI assistants to interact with your tabletop gaming sessions through natural language.

## Features

- **Dice Rolling** — standard RPG notation with any formula
- **Data Querying** — search and inspect actors, items, scenes, journals
- **Game State** — combat tracking, chat messages, user presence
- **Optional Capabilities** — verified compendium search with typed availability states
- **World Search** — full-text search across all game entities
- **Live Connection** — Socket.IO loads complete world state on connect
- **MCP Resources** — `foundry://` URIs for direct data access
- **World Health** — snapshot freshness and connection health; optional Foundry diagnostics remain unavailable

## Quick Start

### Prerequisites

- Node.js 18+ (or [Bun](https://bun.sh/))
- FoundryVTT server running with an active world
- MCP-compatible AI client (Claude Desktop, Claude Code, VS Code, etc.)

### Recommended: Create a Dedicated API User

It is recommended to create a separate FoundryVTT user account for the MCP server rather than using your own GM or player account. This provides better security and auditability.

**In FoundryVTT:**
1. Go to **Configuration** → **User Management**
2. Click **Create User**
3. Set a username (e.g., `mcp-api`) and a strong password
4. Assign the **Assistant GM** role (needed to read world data and roll dice)
5. Use this account's credentials in your MCP configuration

**Benefits:**
- Chat messages and actions from the MCP server are clearly attributed to a separate user
- You can revoke access by disabling the API user without affecting your own account
- Limits blast radius if credentials are ever exposed

### Installation

Run directly without installing — no clone needed:

```bash
bunx foundryvtt-mcp
```

Or with npx:

```bash
npx -y foundryvtt-mcp
```

### Client Configuration

#### Claude Desktop / Claude Code

Add to your MCP configuration (`claude_desktop_config.json` or `.mcp.json`):

```json
{
  "mcpServers": {
    "foundryvtt": {
      "command": "bunx",
      "args": ["foundryvtt-mcp"],
      "env": {
        "FOUNDRY_URL": "http://localhost:30000",
        "FOUNDRY_USERNAME": "your_username",
        "FOUNDRY_PASSWORD": "your_password"
      }
    }
  }
}
```

#### VS Code

Add to your VS Code MCP settings:

```json
{
  "servers": {
    "foundryvtt": {
      "command": "bunx",
      "args": ["foundryvtt-mcp"],
      "env": {
        "FOUNDRY_URL": "http://localhost:30000",
        "FOUNDRY_USERNAME": "your_username",
        "FOUNDRY_PASSWORD": "your_password"
      }
    }
  }
}
```

### Development Setup

For local development or contributing:

```bash
git clone https://github.com/laurigates/foundryvtt-mcp.git
cd foundryvtt-mcp
bun install
bun run setup-wizard
```

The setup wizard will detect your FoundryVTT server, test connectivity, and generate your `.env` configuration.

To configure manually, see the [Configuration Guide](docs/guides/configuration.md).

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `FOUNDRY_URL` | Yes | FoundryVTT server URL (e.g., `http://localhost:30000`) |
| `FOUNDRY_USERNAME` | Yes | FoundryVTT user account |
| `FOUNDRY_PASSWORD` | Yes | FoundryVTT user password |
| `FOUNDRY_USER_ID` | No | Bypass username-to-ID resolution |
| `FOUNDRY_API_KEY` | No | Legacy core REST key; does not establish verified optional support |
| `FOUNDRY_REST_URL` | No | Separate Foundry REST API relay URL |
| `FOUNDRY_REST_CLIENT_ID` | No | Paired module client ID |
| `FOUNDRY_REST_API_KEY` | No | Relay key with search and entity-read permissions |
| `FOUNDRY_AUTHORIZATION_MODE` | No | `service-identity` (default) or `delegated`; delegated reads require an authenticated host resolver |
| `FOUNDRY_WRITE_ENABLED` | No | Enable game-state mutations — `true` required for the write tools (default: `false`) |
| `LOG_LEVEL` | No | `debug`, `info`, `warn`, or `error` (default: `info`) |
| `FOUNDRY_TIMEOUT` | No | Request timeout in ms (default: `10000`) |

## Usage

Ask your AI assistant things like:

- "Roll 1d20+5 for an attack roll"
- "Show me all the NPCs in this scene"
- "What's the current combat initiative order?"
- "Search the world for anything related to dragons"
- "Generate a random NPC merchant"

## Available Tools

### Data Access

- `search_actors` — find characters, NPCs, monsters
- `get_actor_details` — detailed character information
- `search_items` — find world equipment, spells, consumables with stable IDs
- `get_item_details` — read one world item by ID
- `get_scene_info` — current scene details
- `search_journals` — search notes and handouts
- `get_journal` — list a journal's pages with bounded previews and stable page IDs
- `get_journal_page` — retrieve a page's complete text or source in bounded chunks
- `get_users` — list users, roles, and live online status
- `get_combat_state` — combat state and initiative order
- `get_chat_messages` — recent chat history

### Structured actor and item reads

`search_actors`, `get_actor_details`, `search_items` and `get_item_details`
retain readable `content` text and add typed MCP `structuredContent`, validated
against the `outputSchema` advertised by `tools/list`. Version 3 search results
contain `schemaVersion`, `documentType`, `records`, `total`, `page`, `limit`,
`returnedCount`, `nextCursor`, `complete`, `snapshotId`, `expiresAt` and
`consistency: "snapshot"`. Version 2 details contain `schemaVersion`,
`documentType` and `record`. Both include `readMetadata`. Every actor/item record has
`id`, `documentType`, `name` and `type`, plus available mapped fields. Missing
optional values are omitted; zero, false and empty strings remain real values.
Unknown rarity now displays as `Unknown rarity` instead of an invented `Common`.

Search first, select by ID even when names repeat, then pass that ID to the
matching detail tool:

```json
{"name":"search_actors","arguments":{"query":"Goblin"}}
{"name":"get_actor_details","arguments":{"actorId":"Actor00000000001"}}
{"name":"search_items","arguments":{"query":"Potion"}}
{"name":"get_item_details","arguments":{"itemId":"Item000000000001"}}
```

Use actual IDs from the search result; the example IDs above are placeholders.
Only 16-character alphanumeric document IDs are accepted, not names or UUIDs.
World-cache records have verified `Actor.<id>` / `Item.<id>` UUIDs; REST records
omit UUIDs because the REST payload does not establish their source scope.
Item details read only the same world-item collection as `search_items`,
excluding actor-owned and compendium items. Item search applies both type and
rarity filters to the current world-item view.
This contract preserves currently mapped fields, not a complete game-system
sheet or an inventory.

Invalid detail IDs return MCP `InvalidParams` (`-32602`) before backend access.
Missing or removed documents, an unavailable backend, malformed responses and
response ID mismatches return `InternalError` (`-32603`) with diagnostic text.
A connected world with no matching documents returns a successful empty
search; unavailable world data returns an error. REST detail reads use
`/api/actors/:id` and `/api/items/:id`; a REST module without item-detail support
returns its backend error rather than silently selecting a same-name item.

Text consumers can continue reading `content[0].text`; summaries now include
IDs. Structured consumers should check `schemaVersion` and use `record.id` /
`records[].id`, not parse IDs or optional values from Markdown. TypeScript
contracts are exported from `foundry/types` and `foundry/read-contract`.

### Complete journal page reads

`get_journal` returns a version 3 structured summary with journal/page IDs and
verified UUIDs, page type, sort order, source format and visible asset metadata.
Each page preview contains at most 500 Unicode code points; `contentTruncated`
explicitly identifies a shortened preview. Summary results now require
pagination rather than returning every page in one response.

Pass the returned page ID to `get_journal_page` to retrieve its complete content:

```json
{"name":"get_journal","arguments":{"journalId":"Journal000000001","limit":4}}
{"name":"get_journal_page","arguments":{"journalId":"Journal000000001","pageId":"JournalPage00001","format":"text","limit":4}}
```

Use actual 16-character document IDs from the summary, not these placeholders
or UUIDs. Both tools accept `limit` (default 4, maximum 8) and an opaque `cursor`.
Summary limits count pages; content limits count chunks. Repeat the same tool,
IDs, format and limit with `nextCursor` until `complete` is true.

Page content uses schema version 1 with page metadata, `contentLength`, `chunks`,
`contentTruncated`, `paginationPage` and the shared pagination/freshness fields.
Each chunk has `index`, inclusive `start`, exclusive `end` and `content`; offsets
and lengths count Unicode code points. Chunks contain at most 1,024 code points.
Concatenate their content in order to reconstruct the selected format. An empty
text page has one empty chunk; image/video pages have typed metadata and zero
text chunks.

The default `text` format converts HTML without executing it, preserving block
breaks and decoding entities; Markdown remains literal text. `source` returns
the original HTML or Markdown as an inert string. Clients must treat returned
source as untrusted content. Asset references are metadata; the server does not
download or render them.

Parent and page permission checks happen before previews, content, asset
references and totals. Any visible journal content, order or permission change
invalidates both summary and content cursors, including in service-identity
mode. Cursors also bind to the caller, session, world and selected format, and
expire after five minutes. Restart the traversal after invalidation.
These reads require the native Socket.IO backend; REST returns an explicit
unsupported error. See the [integration guide](docs/guides/integration.md#complete-journal-pages)
for compatibility and live test setup.

### Bounded world searches

`search_actors`, `search_items`, `search_journals` and `search_world` accept
`limit` (default 10, maximum 100) and an opaque `cursor`. Keep the original query,
filters and limit on each continuation call; stop when `nextCursor` is null and
`complete` is true. Numeric `page` input is no longer supported. Query and cursor
strings are limited to 1024 characters; type and rarity selectors to 128.

Each traversal captures an immutable snapshot sorted by normalized name,
document type and case-sensitive ID. In service-identity mode, creates, updates
and deletes do not alter that traversal. Delegated reads revalidate permissions
and invalidate cursors when the authorized view changes. A new first-page call
reads the current view. Cursors expire
after five minutes and are bound to the world, caller/session, filters and page
size. Corrupt, expired or mismatched cursors fail explicitly; reconnecting also
invalidates cursors. Restart from the first page to obtain a new snapshot.

Responses are limited to 128 KiB, including MCP text and structured content.
Oversized pages fail with an instruction to request a smaller limit. Snapshots
are capped at 10,000 records and 8 MiB, with at most 32 retained per client
within an aggregate 8 MiB cache budget;
evicted snapshots require a new first-page call.

### World freshness and recovery

In service-identity mode, world reads include `readMetadata` in structured results and readable freshness
text. A validated socket snapshot is `current` while its live stream is connected.
After transport loss, retained records are `stale`; reads still succeed and label
them accordingly. Without a validated snapshot, reads fail as unavailable rather
than returning an empty world. Health diagnostics can report `unavailable` without
requiring a successful world read.

Metadata identifies `source`, `worldId`, `sessionId`, source `snapshotId` and
`revision`. `capturedAt` records source capture, `observedAt` records local receipt
of source data, and `respondedAt` records the response. Repeated reads advance
only `respondedAt`. A page's top-level `snapshotId` identifies its immutable
pagination snapshot; `readMetadata.snapshotId` identifies the source snapshot.
Continuation pages retain their captured source metadata and become `stale`
when the live source advances.

Socket reconnection automatically requests and validates a replacement snapshot.
Manual `refresh_world_data` uses the same bounded recovery path. Existing data
remains stale until replacement succeeds; failed or timed-out recovery does not
promote it to current. Recovery coalesces overlapping requests and rejects late
responses from older sessions. Disconnects and world/session changes invalidate
pagination cursors. REST health availability is reported separately and does not
establish that the socket cache is current.

By default, recovery allows three retries after the initial attempt, with a
10-second acknowledgment timeout per attempt and a 1-second delay between
attempts. `FoundryClientConfig` can override these limits. Recovery buffers at
most 1,000 incoming events; overflow aborts recovery and leaves retained data
stale until a subsequent refresh succeeds.

Service-identity Socket.IO pagination requires a GM session. REST actor/item pagination uses the authenticated
backend's visible collection and requires working backend pagination; it rejects
ignored pages, repeated IDs and inconsistent totals. REST journal/world searches
and scene/journal/user collection pages are unsupported and return errors.

### Authenticated player reads

`service-identity` exposes the configured backend account's data. Use `delegated`
for player access through an embedding host that authenticates each caller and
resolves `{callerId, userId, worldId, sessionId}` from trusted host state. The
exported `FoundryMCPServer` accepts this resolver; the stdio executable has no
resolver and rejects delegated reads. See the [configuration guide](docs/guides/configuration.md#delegated-callers).

Delegated reads require a fresh authoritative socket response for each request.
Actors/items require OBSERVER permission; embedded items and journal pages also
require parent permission. Chat follows author, whisper and blind visibility.
Players receive only their own sanitized user record, and summary counts include
only visible records. Missing authentication, revoked permissions, disconnected
backends and stale cursors fail closed. Errors omit privileged backend details.

Delegated discovery exposes eleven read tools and four collection resources (actors,
items, journals and users). Scenes, tokens, combat, compendia, rules, settings,
diagnostics, refresh and every write are disabled for all delegated callers,
including GMs. REST/API-key backends are unavailable in delegated mode.

### Write Operations (require `FOUNDRY_WRITE_ENABLED=true`)

Game-state mutations are **disabled by default**. They use the Socket.IO
`modifyDocument` protocol over an authenticated session, and the connected user
needs GM/owner permission. Set `FOUNDRY_WRITE_ENABLED=true` to enable them.

- `start_combat` — begin a new encounter, seeding combatants from tokens (does
  not check for an existing combat — calling it during an active one creates a
  second encounter)
- `next_turn` — advance the active combat to the next turn (wraps to the next round)
- `end_combat` — end (delete) the active combat encounter
- `set_initiative` — set a combatant's initiative in the active combat, moving the
  turn marker with the acting combatant if the reorder shifts them
- `move_token` — move a token to new x/y coordinates on its scene
- `apply_status_effect` — apply or remove a status condition (e.g. prone, stunned) on a token's actor
- `update_actor_attributes` — patch an actor's `system` attributes (HP, currency, spell slots, …)
- `create_actor_item` — add an inline item to an actor
- `update_actor_item` — apply a JSON merge patch to an actor's item
- `delete_actor_item` — remove an item from an actor
- `create_journal_entry` — create a journal entry with one or more text pages
  (GM-only by default; pass `visibility` to let players read it)

### World

- `search_world` — full-text search across all game entities
- `get_world_summary` — overview of the current world state
- `refresh_world_data` — request a validated replacement world snapshot; also
  available to retry automatic reconnect recovery

### Game Mechanics

- `roll_dice` — roll dice; dice terms (`NdS`) and whole numbers joined by `+`/`-`, with
  unsupported notation (`4d6kh3`, `1d20r1`, `*`) rejected rather than dropped.
  Parentheses are the one transport difference: FoundryVTT evaluates them when
  `FOUNDRY_API_KEY` is set, the local roller rejects them otherwise
- `lookup_rule` — **stub**: returns a templated placeholder, consults no rules source

### Optional Foundry Capabilities

- `get_capabilities` — actively verify compendium support and report versioned
  `available`, `unavailable`, `unauthorized`, `unreachable` or `incompatible` states
- `search_compendium` — authenticated compendium search with filters, immutable
  pagination and matching text/structured results; unavailable searches return
  null results and total, while a verified search with no matches returns `[]`

Configure all three `FOUNDRY_REST_*` values and pair the module with its relay.
See the [optional capability guide](docs/guides/optional-capabilities.md) for
supported versions, permissions, bounds and live validation. These tools remain
disabled in delegated mode.

### Content Generation

- `generate_npc` — template text; no verified Foundry-backed generation
- `generate_loot` — template text; no verified Foundry-backed generation

`get_capabilities` reports generation and rules lookup as unavailable.

### Diagnostics

- `get_health_status` — connection and world snapshot health, including stale cache state
- `get_recent_logs`, `search_logs`, `get_system_health`, `diagnose_errors` — legacy
  utilities without a verified Foundry diagnostics adapter; registration or a
  configured key does not prove access to Foundry server logs or metrics

`get_capabilities` reports optional Foundry diagnostics as unavailable.

## Available Resources

- `foundry://actors` — a page of world actors
- `foundry://items` — a page of world items
- `foundry://scenes` — a page of scene metadata
- `foundry://scenes/current` — current active scene
- `foundry://journals` — a page of journal metadata
- `foundry://users` — a page of world-user metadata, including inactive users
- `foundry://combat` — active combat state; `combatants` are in initiative order, so
  `combat.turn` indexes them directly
- `foundry://world/settings` — world and campaign settings
- `foundry://system/diagnostics` — legacy utility output; does not establish verified Foundry diagnostics

The five collection resources return version 3 envelopes with `records`, the
same snapshot metadata as searches, and `nextUri` (null on the last page).
Their default page size is 100. Follow `nextUri` or use the advertised resource
template `foundry://actors{?limit,cursor}` (and its item/scene/journal/user
equivalents). For example, start at `foundry://actors?limit=25`. Consumers of the
former unbounded arrays must migrate to `records` and follow every page. The
singleton resources retain their existing fields and add `readMetadata`.

## Troubleshooting

The connectivity and setup helpers ship in the source tree (not the published `bin`), so run them from a dev checkout:

```bash
git clone https://github.com/laurigates/foundryvtt-mcp.git
cd foundryvtt-mcp && bun install
bun run test-connection   # Probe FoundryVTT connectivity
bun run setup-wizard      # Re-run interactive setup
```

Detailed guide: [TROUBLESHOOTING.md](TROUBLESHOOTING.md)

## Development

```bash
bun run build          # Compile TypeScript and make dist/index.js executable
bun run dev            # Development mode with hot reload
bun test               # Unit tests (Vitest)
bun run test:e2e       # E2E tests (Playwright)
bun run lint           # Lint code (Biome)
bun run smoke          # Startup smoke test against the local build
bun run smoke:pack     # Pack-and-install smoke test (mirrors what npx consumers get)
```

See [Development Guide](docs/guides/development.md) for project structure, adding tools, testing, and building.

## Roadmap

See [Feature Tracker](docs/blueprint/feature-tracker.md) for completed and planned features.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT License — see [LICENSE](LICENSE) for details.

## Support

- **Issues**: [GitHub Issues](https://github.com/laurigates/foundryvtt-mcp/issues)
- **Discord**: [FoundryVTT Discord](https://discord.gg/foundryvtt) #api-development
- **Docs**: [FoundryVTT API](https://foundryvtt.com/api/)

## Acknowledgments

- FoundryVTT team for the excellent VTT platform
- Anthropic for the Model Context Protocol
- The tabletop gaming community for inspiration and feedback
