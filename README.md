# FoundryVTT MCP Server

[![npm version](https://img.shields.io/npm/v/foundryvtt-mcp)](https://www.npmjs.com/package/foundryvtt-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server that integrates with FoundryVTT, allowing AI assistants to interact with your tabletop gaming sessions through natural language.

## Features

- **Dice Rolling** — standard RPG notation with any formula
- **Data Querying** — search and inspect actors, items, scenes, journals
- **Game State** — combat tracking, chat messages, user presence
- **Content Generation** — NPCs, loot tables, rule lookups
- **World Search** — full-text search across all game entities
- **Live Connection** — Socket.IO loads complete world state on connect
- **MCP Resources** — `foundry://` URIs for direct data access
- **Diagnostics** — optional server health monitoring (requires REST API module)

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
| `FOUNDRY_API_KEY` | No | REST API module key (enables diagnostics tools) |
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
- `get_journal` — retrieve a specific journal entry
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

### Bounded world searches

`search_actors`, `search_items`, `search_journals` and `search_world` accept
`limit` (default 10, maximum 100) and an opaque `cursor`. Keep the original query,
filters and limit on each continuation call; stop when `nextCursor` is null and
`complete` is true. Numeric `page` input is no longer supported. Query and cursor
strings are limited to 1024 characters; type and rarity selectors to 128.

Each traversal captures an immutable snapshot sorted by normalized name,
document type and case-sensitive ID. Creates, updates and deletes do not alter
that traversal. A new first-page call reads the current cache. Cursors expire
after five minutes and are bound to the world, caller/session, filters and page
size. Corrupt, expired or mismatched cursors fail explicitly; reconnecting also
invalidates cursors. Restart from the first page to obtain a new snapshot.

Responses are limited to 128 KiB, including MCP text and structured content.
Oversized pages fail with an instruction to request a smaller limit. Snapshots
are capped at 10,000 records and 8 MiB, with at most 32 retained per client
within an aggregate 8 MiB cache budget;
evicted snapshots require a new first-page call.

### World freshness and recovery

World reads include `readMetadata` in structured results and readable freshness
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

Socket.IO pagination currently requires a GM session while player visibility
filtering is developed. REST actor/item pagination uses the authenticated
backend's visible collection and requires working backend pagination; it rejects
ignored pages, repeated IDs and inconsistent totals. REST journal/world searches
and scene/journal/user collection pages are unsupported and return errors.

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

### Content Generation

- `generate_npc` — generate NPC text (not written to the world)
- `generate_loot` — generate treasure text for a level (not written to the world)

### Diagnostics (requires REST API module)

- `get_recent_logs` — retrieve filtered FoundryVTT logs
- `search_logs` — search logs by pattern, listing the matching entries
- `get_system_health` — server health status with versions, user/module counts, memory
  and log error counts (no CPU or disk metrics)
- `diagnose_errors` — **stub**: returns a fixed "no errors detected" summary
- `get_health_status` — comprehensive health diagnostics; flags the world snapshot when
  the cache has stopped following live changes

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
- `foundry://system/diagnostics` — system diagnostics (requires REST API module)

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
