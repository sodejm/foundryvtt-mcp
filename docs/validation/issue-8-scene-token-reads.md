# Issue 8 validation receipt

Validated on 2026-10-09 UTC against the disposable local server at
`http://127.0.0.1:30001`: Foundry VTT 14.369, dnd5e 6.0.6, world `test1world`,
and foundry-rest-api 3.4.1. Foundry uses Node 24.13.1; MCP validation used
Node 26.11.0, npm 11.20.0, and Bun 1.4.2.

The implementation is based on issue 7 commit
`6982e22bf3ba394f564a5593427696a86b6d3d1b` (draft PR 31). The plan was committed
as `5abc517`, and the core implementation as `cb6a456`. The final checks below
include the subsequent workflow/integration fixtures and documentation. Each
final command's private receipt reported unchanged inputs during its execution.
Raw logs, runtime configuration and fixture credentials are not repository content.

## Results

| Check | Result | Completed UTC |
| --- | --- | --- |
| Full unit suite and scoped read coverage | 1,244 passed, 47 files, zero skipped | 13:44:48 |
| Full live integration suite | 197 passed, 16 files, zero skipped | 14:03:37 |
| Built MCP workflow suite and TypeScript build | 112 passed, five files, zero skipped | 13:47:21 |
| Biome check | Passed; 11 existing warnings | 13:44:35 |
| TypeDoc check | Passed; six warnings | 13:44:44 |
| Executable smoke | Passed | 13:48:06 |
| Dotenv smoke | Passed | 13:48:47 |
| Packed-consumer smoke | Passed | 13:51:26 |
| Dependency audit | Failed: 32 advisories, one critical, 11 high, 18 moderate, two low | 13:48:07 |

The dependency audit remains an unresolved delivery gate, so this change is a
draft PR. Dependencies and the Bun lockfile are unchanged by issue 8. The current
audit reports two additional low advisories compared with issue 7's receipt;
none of these advisories has been remediated or treated as safe.

## Acceptance evidence

- Three version 1 tools expose typed scene spatial metadata, paginated token
  summaries and parent-qualified token detail: `get_scene_spatial`,
  `list_scene_tokens` and `get_scene_token`. Existing scene summaries and token
  mutations retain their contracts. Advertised output schemas validate both
  structured content and matching JSON text.
- Live Foundry oracles verify dimensions, padding, shifts, origin and grid
  geometry for gridless, square and all four hex orientations, including padded
  gridless and zero-padding hex scenes. Outputs distinguish source dimensions
  from derived dimensions and identify units without inventing coordinate,
  distance, pathfinding or line-of-sight conversions.
- Fixtures cover thirteen scenes, an empty scene, 258 square-scene tokens,
  page sizes 1, 10 and 100, duplicate/Unicode names, negative coordinates, zero
  elevation, grid-space footprints and independent art scaling. Lists omit
  texture metadata; direct detail includes bounded optional texture metadata.
  IDs and `Scene.<sceneId>.Token.<tokenId>` UUIDs compose under the verified parent.
- Live GM and two-player callers compare scene/token visibility and actor
  permissions with native Foundry results. Hidden tokens, secret dispositions,
  denied scenes and inaccessible actors are excluded before counts, pages,
  details and actor references. Actorless visible tokens remain readable.
  Synthetic actor deltas inherit nullable fields and merge explicit ownership
  with the base actor, matching the native fixture behavior.
- Token edits, hiding and deletion, scene resizing, active-scene changes, actor
  revocation and scene revocation are followed by fresh reads and rejected
  continuations. Positive and negative cases cover missing and wrong-parent IDs,
  strict inputs, page bounds, malformed documents, cursor tampering and
  scene/query/limit/tool/caller/session mismatches. Missing and inaccessible
  documents share generic errors.
- Fifteen built MCP spatial workflow tests exercise the actual routers, output
  schemas, combined serialization limit, delegated caller isolation and legacy
  resource denial. Delegated discovery now advertises eighteen verified read
  tools. The full workflow and live suites also exercise inherited actor, item,
  journal, pagination, recovery, REST and caller-permission behavior.
- The loopback scene controller manages only prefixed test fixtures, removes
  those scenes, actors and users, and restores the original active scene. The
  licensed test server remains available for subsequent MCP work.

## Supported boundary and coverage limits

Token pages default to ten records and permit at most 100. Query and cursor
strings are bounded to 1,024 characters. Source capacity is bounded to 10,000
scenes, actors and tokens per scene; combined JSON text and structured content
remain within 128 KiB. Cursors expire after five minutes and bind to world,
caller, session, scene selection, query, limit and the permission-filtered spatial
projection. Active-scene changes invalidate continuations selected implicitly.
Spatial edits and visibility changes invalidate affected cursors.

Native Socket.IO is required; REST explicitly rejects the new spatial reads.
Delegated legacy scene/token tools and raw scene/token resources remain disabled.
These tools return bounded metadata and do not introduce spatial writes or
rendering, combat, range or pathfinding behavior.

The final full unit command enforces 100% statements, branches, functions and
lines across `scene-spatial-contract.ts`, scene handlers, `read-contract.ts`, and
actor/item handlers: 318/318 statements, 348/348 branches, 54/54 functions and
314/314 lines. The focused spatial measurements are 209/209 statements,
229/229 branches, 27/27 functions and 205/205 lines. These are scoped measurements,
not 100% coverage of the Foundry client or repository. Case evidence establishes
the supported contract on the versions above.

## Corrected validation failures

Earlier spatial workflow/live attempts exposed oversized list responses, nullable
synthetic actor deltas, a legacy resource error-code assertion and fixture actor
ordering. Lists now omit texture metadata, nullable overrides inherit native
actor fields, and fixtures/assertions match the observed Foundry behavior. The
focused live spatial suite subsequently passed all 19 tests with zero skips.

The first complete live run passed 196 of 197 tests, including every new spatial
case, but recovery failed because the cleaned world had no active scene. The
recovery suite now creates and activates an owned scene before its readers
connect, verifies its selection, and restores the prior active scene during
cleanup. Its focused rerun passed both tests with zero skips before the final
complete run above.

An initial full workflow invocation encountered the sandbox's local-listener
restriction and an inherited discovery assertion still expecting fifteen tools.
The authorized local-network run with the updated eighteen-tool assertion passed
all 112 tests with zero skips. An initial npm audit failed because this repository
uses a Bun lockfile; the final Bun audit above records its advisory failure.
No new cross-browser navigation smoke was run.
