# Issue 2: bounded world pagination

Issue: https://github.com/sodejm/foundryvtt-mcp/issues/2

Build on issue 1's stable read identifiers. Actor, item, journal and world searches,
and the actors/items/scenes/journals/users collection resources, must expose a
bounded page with an opaque continuation cursor. Singleton resources and the
existing compendium cursor contract remain unchanged.

## Contract and implementation

- Search output schema version 2 adds `returnedCount`, `nextCursor`, `complete`,
  `snapshotId`, `expiresAt` and `consistency: "snapshot"` alongside total/page/limit.
  Detail output remains version 1. Journal and mixed world results contain metadata
  and stable IDs, not full documents.
- Default search size is 10, collection resource size 100, maximum size 100.
  Resource templates accept limit/cursor and return a usable `nextUri`.
- Sort by normalized name, document type, and ID. Capture immutable snapshots;
  subsequent mutations do not alter an existing traversal. New first-page calls
  see the current cache. Cursors expire after five minutes and are bound to filters,
  page size, world, caller/session and snapshot. Reject corruption, context changes,
  expiry, unsupported REST collection access and non-progressing REST pagination.
- Bound record count, snapshot memory, cache count, input size and page payload.
  Oversized snapshots/records fail explicitly instead of silently truncating.
- Socket pagination is GM-only until issue 4 provides proven player filtering.
  REST pagination relies on the authenticated backend's visible collection and
  binds the API-key identity. Totals derive only from that authorized view.

## Work split

One routed implementation subagent owns client/types, the pagination engine and
focused client/engine tests. The parent owns MCP schemas, handlers, resource
templates, documentation and end-to-end tests. Both work on the issue 2 worktree;
file ownership is disjoint. Commit the plan, implementation and verified workflow
separately, then open a stacked PR against issue 1 without merging either PR.

## Validation

Traverse 0, 1, exactly one page, 101 and 250+ records, including duplicate names
and filters, and assert exact ID sets without duplicates. Exercise limit/input
bounds, corrupt/replayed/expired/context-mismatched cursors, mutation consistency,
REST adapter progress failures, tool/resource parity and published schemas.
Run unit coverage, MCP workflow tests, build, lint, documentation, package and
startup smoke checks. Seed identifiable fixtures on disposable local Foundry
14.369 / dnd5e 6.0.6 and traverse through the actual stdio MCP interface. Record
Socket live evidence separately from REST protocol fixtures; skipped cases are
not passes. Broader refresh failures remain tracked by issue 3.
