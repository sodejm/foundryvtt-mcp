# Configuration Guide

## Environment Variables

Copy `.env.example` and set the required values:

```bash
cp .env.example .env
```

### Required

| Variable | Description |
|----------|-------------|
| `FOUNDRY_URL` | FoundryVTT server URL (e.g. `http://localhost:30000`) |
| `FOUNDRY_USERNAME` | FoundryVTT user account |
| `FOUNDRY_PASSWORD` | FoundryVTT user password |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `FOUNDRY_USER_ID` | — | 16-char document `_id` (bypasses username resolution) |
| `FOUNDRY_API_KEY` | — | Legacy core REST key; does not verify optional diagnostics |
| `FOUNDRY_REST_URL` | — | Separate paired Foundry REST API relay URL |
| `FOUNDRY_REST_CLIENT_ID` | — | Module client ID registered with that relay |
| `FOUNDRY_REST_API_KEY` | — | Relay key permitting search and entity reads |
| `FOUNDRY_AUTHORIZATION_MODE` | `service-identity` | Backend-account access, or `delegated` with a trusted host caller resolver |
| `LOG_LEVEL` | `info` | Logging verbosity (`debug`, `info`, `warn`, `error`) |
| `NODE_ENV` | `development` | Environment mode |
| `FOUNDRY_TIMEOUT` | `10000` | Request timeout in ms |
| `FOUNDRY_RETRY_ATTEMPTS` | `3` | Retry failed requests |
| `FOUNDRY_RETRY_DELAY` | `1000` | Delay between retries in ms |
| `CACHE_ENABLED` | `true` | Enable response caching |
| `CACHE_TTL_SECONDS` | `300` | Cache duration in seconds |
| `CACHE_MAX_SIZE` | — | Maximum cache entries |

## Server Settings

```env
# Logging
LOG_LEVEL=info  # debug, info, warn, error

# Performance
FOUNDRY_TIMEOUT=10000      # Request timeout (ms)
FOUNDRY_RETRY_ATTEMPTS=3   # Retry failed requests
```

## Security

- Limit FoundryVTT user permissions to the minimum required
- Run the server on an internal network only
- Monitor logs for suspicious activity

## Delegated Callers

The default `service-identity` mode serves the configured Foundry account's view.
It is suitable for a trusted single-account client; exposing a GM connection to
players requires `delegated` mode and a host that authenticates those players.

An embedding host can import `FoundryMCPServer` from `dist/index.js` without
starting the CLI. Pass `resolveCaller` and start it with the host's MCP transport:

```typescript
import { FoundryMCPServer } from './dist/index.js';

// Set FOUNDRY_AUTHORIZATION_MODE=delegated before importing the server.
// verifiedSessions belongs to the authenticated host, not MCP tool arguments.
const server = new FoundryMCPServer({
  resolveCaller: async ({ authInfo, sessionId }) => {
    const principal = await verifiedSessions.resolve(authInfo, sessionId);
    if (!principal) return undefined;
    return {
      callerId: principal.id,
      userId: principal.foundryUserId,
      worldId: principal.foundryWorldId,
      sessionId: principal.authenticatedSessionId,
    };
  },
});
await server.start(authenticatedTransport);
```

`verifiedSessions` and `authenticatedTransport` are host-provided components;
this package does not implement that login service. The resolver receives only
the SDK's `authInfo` and `sessionId`. Resolve mappings from verified host state,
and never trust IDs or roles in tool arguments, resource URIs or request `_meta`.
All four context fields must be nonempty bounded strings. The Foundry user must
still belong to the expected active world and have a valid non-banned role.
The standalone stdio executable has no resolver, so delegated reads are denied.

Each request obtains a fresh authoritative world response over the connected
socket and projects a separate caller view. Stale cached data cannot authorize
a delegated response. API-key/REST mode is rejected. Permission revocation,
membership loss, world/session changes and reconnects invalidate continuations.
Any change to the authorized view also requires restarting pagination. Cursor
failures use `InvalidParams` with a generic message; missing trusted context uses
`InvalidRequest`. Hidden and absent direct IDs return identical errors.

Supported tools are `search_actors`, `get_actor_details`, `search_items`,
`get_actor_sheet`, `get_actor_section`, `list_actor_items`, `get_actor_item`,
`get_item_details`, `search_journals`, `get_journal`, `get_journal_page`, `get_chat_messages`,
`get_users`, `search_world`, `get_world_summary`, `get_scene_spatial`,
`list_scene_tokens` and `get_scene_token`. Collection resources are
`foundry://actors`, `foundry://items`, `foundry://journals` and `foundry://users`.
Filtering occurs before sorting, pagination and counts. Actors/items require
OBSERVER or OWNER; explicit, default and inherited ownership are honored, and
unknown ownership fails closed. Embedded items require their actor's permission;
journal pages require their entry and page permissions. Chat content follows
author, whisper-recipient and blind-message visibility. Players see only their
own user record, stripped of credentials and flags; assigned characters are
included only when visible. Summary counts derive from these visible collections.

Actor-sheet reads use conservative DND5e and PF2e field profiles. Actor and
embedded-item permissions are checked before fields, inventory counts and IDs
are serialized. Rich actor biographies and item descriptions are withheld from
delegated callers, including delegated GMs. Unknown-system sheet, section and
inventory reads fail closed because no field-visibility profile is established;
service-identity mode supports a bounded primitive system-path fallback.

Structured spatial reads check scene OBSERVER permission and token visibility
before counts, pages or details. Hidden tokens and tokens
with inaccessible linked or synthetic actors are excluded for players. Actor
references are emitted only when observable. See the
[spatial read contract](integration.md#structured-scene-and-token-reads).

Legacy scene/token reads and resources, combat, compendia, rules, settings,
diagnostics, refresh and all writes remain disabled in delegated mode, including
for GM callers. These surfaces need their own visibility/write contracts.

## FoundryVTT Authentication

The MCP server connects to FoundryVTT via Socket.IO using a standard user account. Core world reads require no custom module. Optional compendium reads use a separate authenticated module and relay.

### Setup

1. Ensure FoundryVTT is running with an active world (not on the setup screen)
2. Create or use an existing FoundryVTT user account with appropriate permissions
3. Add credentials to your `.env` file

### Authentication Flow

The server authenticates via a 4-step Socket.IO flow:

1. Fetches the `/join` page to obtain a session cookie
2. Extracts the session cookie from the response
3. Resolves the username to a user ID (or uses `FOUNDRY_USER_ID` if set)
4. Emits `joinGame` with credentials to receive the complete world state

### Required Permissions

Your FoundryVTT user needs:

- View actors, items, scenes, and journals
- Access compendium data
- Use dice rolling API

### Optional: Verified Compendium Search

Configure the separate relay alongside the existing Socket.IO connection:

```env
FOUNDRY_REST_URL=http://127.0.0.1:3010
FOUNDRY_REST_CLIENT_ID=your_relay_client_id
FOUNDRY_REST_API_KEY=your_scoped_relay_key
```

The module must be enabled in the active world, paired with that relay, and
connected through an active GM browser. The relay key needs search and entity-read
permissions. Call `get_capabilities` to verify actual authenticated search and
entity responses. A configured key or public status response cannot prove support.
See [optional capabilities](optional-capabilities.md) for tested versions and limits.

The legacy `FOUNDRY_API_KEY` setting does not enable verified Foundry diagnostics.
Rules lookup, Foundry-backed generation and optional diagnostics are reported as
unavailable until compatible adapters are implemented and verified. Local
[creative NPC and loot previews](content-generation.md) require no provider
credentials, report their limitations and do not persist world data.
