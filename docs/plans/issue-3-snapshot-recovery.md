# Issue 3: truthful cached reads and recovery

## Behavior

Socket reads allow an explicitly labelled stale snapshot. Reads before any validated snapshot fail as unavailable. Every successful cached tool/resource read includes `readMetadata`: source (`socket` or `rest`), freshness (`current`, `stale`, `unavailable`), worldId, sessionId, snapshotId, revision, capturedAt, observedAt, and respondedAt. Source times change only when data is captured or a broadcast is applied; response time is separate. A pagination snapshot keeps its source metadata and becomes stale if its source revision is superseded.

Actor/item search and world/journal collection schema versions advance to 3; actor/item detail advances to 2. The immutable page snapshot identifier remains separate from the world snapshot identifier in readMetadata. Legacy text tools include metadata in text and structuredContent. Health reports connection and snapshot freshness separately. REST transport observation does not assert socket freshness.

## Recovery

Use Foundry's `world` acknowledgement protocol. Validate world identity and required collections before publication. Coalesce manual and automatic refresh, bound timeout/retry attempts, retain stale data on failure, reject late callbacks from retired sockets/sessions, and buffer/replay supported broadcasts received while refreshing. Session/world changes retire prior snapshots and cursors. Reconnect starts automatic recovery; only a validated replacement restores current status. Listener cleanup and cancellation must remain bounded.

## Ownership and sequence

1. Core client/freshness/pagination implementation and deterministic client tests in a bounded subagent task.
2. Parent updates read contracts, handlers/resources, health, documentation, and integration assertions without editing core-owned files.
3. Integrate and run build, unit, focused coverage, lint, docs, smoke/pack, real MCP reads and outage/recovery on local Foundry 14.369, dnd5e 6.0.6, test1world, no modules. Record failures and skips explicitly.
4. Commit milestones, push a stacked PR over issue 2, and update issue 3 before selecting the next issue. Do not merge or close issues.

## Acceptance evidence

Deterministic tests cover stable timestamps, unavailable versus empty, stale policy, deduplicated recovery, timeout/malformed ACK, reconnect/session races, buffered document/presence events, cursor invalidation, listener bounds, and REST liveness separation. Real tests must exercise a disconnected MCP client while a separate Foundry session changes documents and presence, then verify refreshed data and truthful metadata after recovery. Run existing document, presence, health, auth, pagination, and workflow regressions. Unknown API/module support and skipped tests are limitations, never passes.
