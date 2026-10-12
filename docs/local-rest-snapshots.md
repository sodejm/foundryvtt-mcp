# Local REST snapshot validation

The maintained REST module and relay implement the actor/item collection and
detail routes and world identity required by MCP. Both artifacts are versioned
`3.4.2-mcp.1`. Use both forks together; the upstream `3.4.1` artifacts do not
provide this collection contract.

## Pinned components

| Component | Repository | Revision |
| --- | --- | --- |
| REST module | [sodejm/foundryvtt-rest-api](https://github.com/sodejm/foundryvtt-rest-api) | 3a804cce7ed144359aae1987a375ce6e4a2db366 |
| REST relay | [sodejm/foundryvtt-rest-api-relay](https://github.com/sodejm/foundryvtt-rest-api-relay) | 9b35f548b460dc2454d05ea88f0bd495907cdc0e |
| Foundry | Licensed local install | 14.369 |
| System | dnd5e | 6.0.6 |

The disposable world is `test1world` at `http://127.0.0.1:30001`. Validation in
this record is local only. It does not establish Foundry 13 compatibility,
credentialed hosted integration, or npm publication. Issues #24, #15 and #17
retain their external acceptance requirements; tracker #14 remains open.

## Contract and bounds

GET `/api/actors`, `/api/items`, their `/{id}` detail routes, and `/api/world`
require a scoped key with `entity:read`, an allowed client, and a live bound
Foundry user. Caller context is injected by the relay and checked again against
the live key. Missing identity or document resolution fails closed. Documents
and embedded contents require the bound user's OBSERVER permission before
filtering, sorting, counting or paging.

Collections return `snapshotId`, `total`, `page`, `limit`, and `actors` or `items`.
Start at page 1 and reuse the snapshot ID. The backend sorts by normalized name,
type, then case-sensitive ID. Snapshots bind the key, user, world, collection,
filters, and page size. Serialized records are frozen; document, permission,
world and reconnect hooks explicitly invalidate them. MCP revalidates the
backend snapshot before returning cached continuations, including resource pages.

Expiry is five minutes. Limits are 10,000 records per snapshot, 8 MiB shared
serialized data, 32 active snapshots, and bounded invalidation tombstones.
Oversized, expired, invalidated, mismatched, and full-cache requests return errors
without silent truncation. REST limits are 1–100; MCP response limits and its
existing public cursor interface remain unchanged.

## Reproduce the local MCP check

Build and deploy the pinned module into the local test world's module directory;
build the pinned relay with `go build ./cmd/server` in `go-relay`. Run the relay
on loopback port 3010 with `BIND_HOST=127.0.0.1`, `PORT=3010`,
`REDIS_ENABLED=false`, and its own private data directory. Keep relay secrets and
database files outside Git. The module must be enabled in `test1world`.

Run `bun install --frozen-lockfile` and `bun run build` in the MCP checkout.
Provide a private env file containing `FOUNDRY_URL=http://127.0.0.1:30001`,
`FOUNDRY_USERNAME` and `FOUNDRY_PASSWORD` for the test Gamemaster. Set the
credential path outside the repository; the controller writes it with mode 0600.

```sh
export FOUNDRY_FIXTURE_ENV=/private/tmp/foundry-read-fixtures.env
export FOUNDRY_REST_FIXTURE_CREDENTIALS=/private/tmp/foundry-rest-fixtures.json
# Optional when the Playwright Chromium executable is installed elsewhere:
# export PLAYWRIGHT_EXECUTABLE_PATH=/absolute/path/to/chromium
node scripts/local-rest-fixture-controller.mjs
```

The controller checks the exact loopback server and world, creates four test
users and scoped keys, pairs the module with the relay, and listens on
`127.0.0.1:3011`. It only mutates its flagged actor/item fixtures. Its compendium
endpoints replace `world.mcp-capability-fixtures`. This controller is for the
disposable local server; it grants test Gamemaster operations on that server.

In another shell, using the same credential path:

```sh
export FOUNDRY_URL=http://127.0.0.1:30001
export FOUNDRY_REST_FIXTURE_CREDENTIALS=/private/tmp/foundry-rest-fixtures.json
LOG_LEVEL=error node scripts/local-rest-snapshot-check.mjs
```

The checker uses real REST requests through the production MCP server and SDK
transport. It creates and mutates fixture documents and verifies exact traversal,
schemas, response budgets, tool and resource continuations, revocation and
reconnects. It fails on skipped assertions. `FOUNDRY_REST_RESULT_FILE` optionally
writes a sanitized result file.

Stop the controller with SIGINT or SIGTERM to remove its temporary browser
profile. Remove the private credential and env files when testing is finished.
Keys and test users remain in the disposable server for repeat runs; revoke them
or reset that test server when no longer needed.

## Recorded evidence

- [Direct REST results](evidence/rest-snapshots/snapshot-live-results.json):
  Player, Trusted Player, Assistant and GM; owned/shared/hidden/limited and
  embedded contents; authorized totals; world identity; cross-caller replay,
  spoofed identity, missing scope/binding, invalid paging, CRUD, permission
  revocation and reconnects.
- [MCP REST results](evidence/rest-snapshots/mcp-rest-results.json): all four
  roles, tools and resources, duplicate-name traversal, schema/payload checks,
  CRUD and permission invalidation, reconnects, and exact 0/1/100/101/251 counts.
- [Bounds results](evidence/rest-snapshots/snapshot-bounds-results.json): 10,001
  records, oversized serialized data, and aggregate cache exhaustion all fail
  explicitly.
- [Real expiry](evidence/rest-snapshots/expiry-results.json): after 311,402 ms,
  the backend returns `SNAPSHOT_EXPIRED`.

Local Socket integration also passed 41 cases in two files against this install.
The MCP suite passed 1,819 tests in 67 files with no skips and 100% coverage for
the six required read modules; workflow tests passed 791 cases in seven files.
Build, lint, documentation, startup/dotenv/package smoke checks, dependency audit,
secret scan, Semgrep scan/rule tests and workflow policy checks passed. The module
passed 54 tests and its build; the relay passed `go test ./...` and its build.

These are bounded acceptance checks for the snapshot change. They do not claim
that every advertised feature has been retested on both supported Foundry majors.
