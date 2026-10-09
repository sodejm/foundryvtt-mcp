# Optional Foundry Capabilities

Core world reads keep the authenticated Socket.IO connection. Compendium search
uses the separate [ThreeHats Foundry REST API](https://github.com/ThreeHats/foundryvtt-rest-api)
module and its [relay](https://github.com/ThreeHats/foundryvtt-rest-api-relay).
Configure all three values alongside the core Foundry credentials:

```env
FOUNDRY_REST_URL=http://127.0.0.1:3010
FOUNDRY_REST_CLIENT_ID=your_relay_client_id
FOUNDRY_REST_API_KEY=your_scoped_relay_key
```

Enable the module in the world, pair it with that relay, and leave a GM browser
connected. The key must permit both search and entity reads. The adapter sends
`x-api-key` with authenticated `/search` and `/get` requests, validating response
shape and entity identity. The relay URL is separate from `FOUNDRY_URL`.

## Capability Contract

`get_capabilities` returns `schemaVersion: 1` and a capability for each feature.
Each record includes `feature`, `status`, a fixed redacted `reason`, optional
`remediation`, ISO `verifiedAt` and `transport: "rest"`.

| Status | Meaning |
|--------|---------|
| `available` | Authenticated compendium search and entity reading succeeded |
| `unavailable` | Missing configuration, unavailable module/route, no entry to verify, or unsupported feature |
| `unauthorized` | Rejected key or missing required key permissions |
| `unreachable` | Network failure or request timeout |
| `incompatible` | Invalid response schema, mismatched entity, or an unprovable complete result set |

A key or public Foundry status response is insufficient verification. An empty
installation needs at least one compendium entry to prove entity reading.
`rulesLookup`, `diagnostics` and `contentGeneration` remain unavailable because
their Foundry-backed adapters are not implemented and verified. NPC/loot templates
and legacy diagnostics utilities do not establish support. `get_health_status`
separately reports connection and world snapshot health. `diagnose_errors` returns
a strict, versioned unavailable result without inferring health or retrieving
logs. See [error diagnosis](error-diagnosis.md) for input validation and output.

The legacy `FOUNDRY_API_KEY` core REST connection path is separate from this
adapter. Its status-probe concern is tracked in
[upstream issue 230](https://github.com/laurigates/foundryvtt-mcp/issues/230);
this capability check does not depend on that probe.

## Rule Lookup

`lookup_rule` accepts a required nonblank `query` of 1–256 characters and an
optional nonblank `system` of 1–128 characters. Unknown fields, wrong types,
whitespace-only values and excessive lengths fail with MCP `InvalidParams`.
Omitting `system` does not select a default game system.

For example, `{"query":"Opportunity attack","system":"dnd5e"}` returns:

```json
{
  "schemaVersion": 1,
  "capability": {
    "feature": "rulesLookup",
    "status": "unavailable",
    "reason": "No verified rules provider is implemented.",
    "remediation": "Consult an authoritative rules source or configure a verified rules provider."
  }
}
```

The strict advertised output schema permits only this unavailable envelope.
JSON text matches `structuredContent`; the combined response is bounded to
128 KiB. Capability discovery shares the same feature, status, reason and
remediation, with its existing verification timestamp and transport metadata.

No rule provider is currently implemented or configurable in this server.
Lookup performs no Foundry, relay, compendium, journal or source-content access.
Every valid query, including nonsense and an unknown system or version, returns
unavailable. It has no successful matches, no-match or ambiguity results,
provenance, invented mechanics or fabricated citations. Source denial, provider
timeouts and malformed provider responses require an implemented provider and
are not claimed as supported states. Delegated callers cannot discover or call
the tool; caller authorization runs before input validation.

This replaces the former generated placeholder text. Consumers should validate
`schemaVersion` and `capability.status` rather than interpret text as retrieved
rules. See [issue 9 validation](../validation/issue-9-truthful-rule-lookup.md)
for the positive and negative test matrix.

## Search and Pagination

```json
{
  "query": "Fire",
  "filters": {
    "compendiumId": "world.spells",
    "packType": "Item",
    "itemType": "spell",
    "spellLevel": 1,
    "source": "2024"
  },
  "limit": 20
}
```

`search_compendium` accepts a query up to 1,024 characters, optional filters,
`limit` from 1 to 100 (default 20), and an opaque cursor. Pack, document type and
item subtype filters apply at the relay. Spell level and source apply after
hydration; source matches `system.source.rules` or `custom` exactly, ignoring case
and surrounding whitespace. Missing metadata cannot match a requested filter.
Text filters are bounded to 128 characters; pack/type filters reject commas,
colons and newlines.

An available response contains `results`, `total`, page metadata and `nextCursor`.
Only a verified search with no matches returns `results: []` and `total: 0`.
Unavailable responses instead contain `restAvailable: false`, the explicit
capability state, and null `results`, `total`, `page` and `nextCursor`.
MCP text content and structured content contain the same envelope.

Results are hydrated and captured as an immutable snapshot, ordered by name,
pack and ID. The relay supplies no source capture timestamp, so read metadata
uses null `capturedAt` and preserves the original local `observedAt` across pages.
Repeat the same query, filters and limit with `nextCursor` to continue.
Cursors expire after five minutes and bind to the query, backend identity,
world and session. Every continuation verifies authenticated support again.
Key revocation, module loss and socket/session changes invalidate snapshots;
restored access requires a fresh search. Both optional tools are disabled for
delegated callers because the relay does not prove per-caller permissions.

## Bounds and Relay Compatibility

- Each HTTP response is bounded to 2 MiB and uses `FOUNDRY_TIMEOUT` (default 10 seconds).
- Search requests at most 500 results. Reaching that ceiling reports `incompatible`
  and requests narrower filters rather than claiming a complete result set.
- Pages are bounded to 128 KiB. Snapshot storage is bounded to 32 entries and
  8 MiB per paginator; oversized results fail without a partial page.
- Relay 3.4.1 uses request type plus millisecond timestamps as HTTP request IDs.
  Requests from all adapters to one origin in this MCP process are serialized
  with a two-millisecond spacing to avoid collisions. Separate processes still
  share that upstream limitation; mismatched entity responses fail validation.
- Relay rate limiting reports unavailable with remediation. The disposable local
  test relay uses a higher request allowance for the 251-entry validation workload.

## Verified Local Matrix

| Component | Tested version |
|-----------|----------------|
| Foundry | 14.369 |
| System | dnd5e 6.0.6 |
| REST module | 3.4.1 (`6e00fe28`) |
| REST relay | 3.4.1 (`c5efd93d`) |

The built MCP stdio integration suite uses disposable `test1world`, an active GM
browser controller and a paired local relay. It checks schema/text parity,
socket-only operation, a plain Foundry origin, wrong and insufficient-scope keys,
real zero-match results, filters and metadata, 1/100/101/251-entry traversals,
key revocation, module removal and recovery. Unit/workflow tests additionally
cover 404, timeout, rate limiting, malformed responses, capacity, cursor isolation
and invalidation. This matrix does not claim compatibility with untested versions.

`tests/integration/compendium.integration.test.ts` requires explicit
`FOUNDRY_REST_URL`, `FOUNDRY_REST_TEST_CONTROL_URL`,
`FOUNDRY_REST_TEST_FIXTURES` and the core Foundry credentials. The fixture file
holds disposable relay keys and its management session outside source control.
The controller supplies `/status`, `/seed`, `/seed-paging`, `/enable` and `/disable`
operations against the test world. Missing prerequisites fail instead of skipping.
