# Issue 8: structured scene grid and token reads

Issue: https://github.com/sodejm/foundryvtt-mcp/issues/8

Branch: `codex/issue-8-scene-token-reads`, based on issue 7 commit
`6982e22bf3ba394f564a5593427696a86b6d3d1b` (draft PR 31).
Upstream was rechecked before implementation and remains
`23a28b2ee8031997e37de855493ecb73f5147a92`.

## Contract

Keep the existing scene summary and raw resource authorization compatible. Add
versioned, bounded structured tools for scene spatial metadata, paginated scene
tokens, and direct token detail. Explicit scene IDs are stable; an omitted scene
ID resolves the active scene. Continuations bind the resolved scene and reject
changes to the active-scene selection, projected records, caller, or permissions.

Scene metadata includes identity, raw scene dimensions, padding, shifts, origin,
grid type, pixel size, world distance and units. Preserve absent values and zero.
Support square, all four hex orientations, and gridless data. Verify derived
geometry against native Foundry dimensions; explicitly mark unavailable or
unsupported conversions. Do not infer pathfinding, line of sight, or distance.

Token summaries include stable scene/token IDs and UUIDs, pixel coordinates,
grid-space footprint, rotation in degrees, elevation in scene distance units,
linked/unlinked actor identity only where observable, and explicit unit metadata.
Texture scaling does not change the footprint. Filter hidden and inaccessible
documents before lookup, counts, pagination, and serialization. Use a distinct
spatial permission projection, without enabling raw scene/token delegated reads.
Respect native scene and token/actor ownership, including unlinked actor deltas;
ambiguous data fails closed. Bind permission and spatial changes into freshness.

REST backends that cannot prove the same visibility and geometry contract report
unsupported reads. Reuse the existing metadata, strict schema and snapshot
paginator, including its 128 KiB response limit, 100-record page limit, source
limits, cursor authentication, caller/session binding, and expiration.

## Ownership and checkpoints

The core agent owns `src/`, including unit tests. The parent owns this plan,
`scripts/scene-test-control.mjs`, integration and workflow tests, README and
documentation. The agent reports public schemas early. Only the parent commits
and publishes. Commit planning, implementation, and validation at meaningful
checkpoints; publish a draft PR based on issue 7 before starting issue 9. Do not
merge the stack or close issues without separate authority.

## Verification

Cover square, hex and gridless scenes, padding/shifts, zero and negative token
coordinates/elevation, art scaling, actorless and linked/unlinked tokens, missing
or malformed data, duplicate names and collections exceeding one page. Use a GM
and two players to verify hidden-token lookup/counts, scene access, actor
references, synthetic ownership, caller isolation and revocation. Verify source
updates, active-scene switches and permission changes while paging, cursor
tampering, query/scene mismatch, response bounds, schemas, units and freshness.

Live fixtures use only disposable `test1world` at `http://127.0.0.1:30001`, Foundry
14.369, dnd5e 6.0.6, foundry-rest-api 3.4.1. A loopback controller on port 3014
creates only prefixed fixtures, records native dimensions and document permission
oracles, exposes fixed fixture mutations, and cleans only its fixtures. Required
live tests must run with zero skips. The headless GM browser uses `core.noCanvas`.

Run build, unit tests with focused spatial coverage, workflow tests, full live
integration, lint, docs check, smoke, dotenv smoke and package smoke. Validate the
built MCP schemas and caller boundary, not only projection helpers. Record exact
counts, versions, results, limitations and inherited dependency audit failures;
do not equate planned case coverage with whole-repository coverage. Scan outgoing
commits for secrets before publishing.
