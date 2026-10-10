# Issue 11 validation receipt

Validated on 2026-10-09 UTC against the disposable local server at
`http://127.0.0.1:30001`: Foundry VTT 14.369, dnd5e 6.0.6, world `test1world`,
and foundry-rest-api 3.4.1. Foundry uses Node 24.13.1; MCP validation used
Node 26.11.0, npm 11.20.0, and Bun 1.4.2.

The implementation is based on issue 10 commit
`cdc69ac4d9f7c8645907e295e7b48da41df98f46` (draft PR 34). The plan was committed
as `219d8ca`, source implementation as `2690604`, and built/live tests and user
documentation as `52958f8`. Private command receipts record whether inputs
changed during execution. Raw logs, fixture credentials, runtime configuration
and generated dependencies are not repository content.

## Results

| Check | Result | Completed UTC |
| --- | --- | --- |
| Full unit suite and scoped coverage | 1,378 passed, 55 files, zero skipped | 15:37:32 |
| Full live integration suite | 306 passed, 19 files, zero skipped | 15:56:24 |
| Built MCP workflow suite and TypeScript build | 238 passed, six files, zero skipped | 15:40:08 |
| Biome check | Passed; 11 existing warnings | 15:37:17 |
| TypeDoc check | Passed; six warnings | 15:37:27 |
| Executable smoke | Passed | 15:42:24 |
| Dotenv smoke | Passed | 15:42:24 |
| Packed-consumer smoke | Passed | 15:43:11 |
| Dependency audit | Failed: 32 advisories, one critical, 11 high, 18 moderate, two low | 15:42:55 |

The dependency audit remains an unresolved delivery gate, so this change is a
draft PR. Dependencies and the Bun lockfile are unchanged by issue 11. None of
the reported advisories has been remediated or treated as safe.

## Acceptance evidence

- Both generation tools return strict, versioned JSON creative previews with
  matching text and structured content. Every preview explicitly reports
  nonpersistence and unverified rules, null system identity, supported options,
  defaults applied, and limitations. No document ID or system statistics are
  fabricated. AJV validates the advertised output schemas through built MCP.
- NPC level, race and class are honored. Level determines a documented narrative
  scale; supplied text retains its exact spelling. Default, boundary, Unicode,
  hostile and maximum-length options are tested. No assertion presents narrative
  scale as a mechanical challenge rating or balanced encounter.
- Loot challenge rating and treasure type affect the documented fictional
  currency formula and item count. Each currency uses an explicit unit and
  conversion; its subtotal is arithmetically reproducible. Items and overall
  treasure value remain unknown. The fictional formula is not a verified system
  economy or licensed treasure table.
- Strict input schemas reject wrong types, blank strings, excessive lengths,
  out-of-range or fractional NPC levels, unsupported treasure types and unknown
  keys. Both routers and handlers preserve MCP InvalidParams behavior. Delegated
  caller authorization runs first and blocks these tools with InvalidRequest,
  including malformed arguments.
- Unit and workflow checks prove generation accesses no Foundry client or HTTP
  endpoint and stays within the shared 128 KiB response bound. Capability
  discovery explicitly separates available creative previews from unavailable
  verified system-specific generation. Independent compendium availability is
  preserved.
- Fifty-nine live generation cases exercise built stdio MCP against the real
  world using native Foundry Socket.IO and optional REST configurations.
  Independent browser status verifies the exact world and server/system versions.
  Successful and rejected inputs, schemas, capability distinction, credential
  redaction and collection-count preservation are checked. Refreshing the native
  snapshot after generation preserves real world collection counts across both
  tools and transports. This count check does not claim a deep document diff.
- The full live suite also covers inherited caller-permission, snapshot/recovery,
  actor/item, journal, scene/token, pagination, REST, rule and diagnosis behavior.
  Inherited fixture controllers clean their owned prefixed fixtures and restore
  the prior active scene. The licensed server remains available for MCP testing.

## Supported boundary and coverage limits

Issue 11 permits a creative-preview boundary until verified generation exists.
The tools create no Foundry actor, item or other document. No configured system
adapter, verified stat block, encounter balance, rule source, priced item or
complete treasure valuation is claimed. Separate mutation tools retain their
existing behavior; `create_actor_item` requires an existing actor.

NPC level is an integer from 1 through 20. Race and class contain nonwhitespace
text and at most 64 UTF-16 code units. Loot challenge rating is finite and from
0 through 30; treasure type is `individual` or `hoard`. Defaults and the exact
fictional currency formula are documented in
[`content-generation.md`](../guides/content-generation.md).

The full unit command enforces 100% statements, branches, functions and lines
across eleven modules: `read-contract.ts`, actor/item handlers,
`scene-spatial-contract.ts`, scene handlers, `rule-contract.ts`, rule handlers,
`diagnosis-contract.ts`, `error-diagnosis.ts`, `generation-contract.ts` and
`generation.ts`: 409/409 statements, 378/378 branches, 66/66 functions and
404/404 lines. The new generation contract and handler measure 64/64 statements,
26/26 branches, 8/8 functions and 63/63 lines. These are scoped measurements,
not 100% coverage of the client or repository.

## Validation integrity

All final command receipts report unchanged inputs during execution and no
report warning. Required suites contain no skipped tests. A first workflow run
exposed a test/documentation reference to nonexistent `create_actor`; it was
corrected to the implemented `create_actor_item` and the full workflow suite
passed. A first live run compared refreshed snapshot metadata; the assertion was
corrected to compare collection counts and the full live suite passed. Neither
earlier failed run is counted as passing validation.

The final live run completed from 15:50:30 through 15:56:24 UTC using explicit
private credentials and fixture controllers. No credential or raw configuration
is included here. No failing behavioral test remains. The failed dependency audit
and existing Biome/TypeDoc warnings are reported separately from passing checks.
Final repository additions after these runs consist only of this validation record.
