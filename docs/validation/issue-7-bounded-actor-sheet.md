# Issue 7 validation receipt

Validated on 2026-10-09 UTC against the disposable local server at
`http://127.0.0.1:30001`: Foundry VTT 14.369, dnd5e 6.0.6, world `test1world`,
and foundry-rest-api 3.4.1. Foundry uses Node 24.13.1; MCP validation used
Node 26.11.0, npm 11.20.0, and Bun 1.4.2.

The implementation is based on issue 6 commit
`79a89fd6c78f8aa774eebbb23f93926aa6ccc51f`. The plan was committed as `67d9bb3`,
and the core implementation as `5348f95bcea6ae67479333b5a5165137208b8e10`.
The following checks include the subsequent tests and documentation in this
validation commit. Each final command's private receipt reported unchanged inputs
during its execution; raw logs and fixture credentials are not repository content.

## Results

| Check | Result | Completed UTC |
| --- | --- | --- |
| Full unit suite and scoped read coverage | 1,173 passed, 44 files, zero skipped | 10:33:07 |
| Full live integration suite | 178 passed, 15 files, zero skipped | 10:37:35 |
| Focused live caller-permission suite | 20 passed, zero skipped | 10:31:15 |
| Built MCP workflow suite and TypeScript build | 97 passed, four files, zero skipped | 10:39:47 |
| Biome check | Passed; 11 existing warnings | 10:32:55 |
| TypeDoc check | Passed; six warnings | 10:33:03 |
| Executable smoke | Passed | 10:41:44 |
| Dotenv smoke | Passed | 10:41:58 |
| Packed-consumer smoke | Passed | 10:44:03 |
| Dependency audit | Failed: 30 advisories, one critical, 11 high, 18 moderate | 10:16:50 |

The dependency audit remains an unresolved delivery gate, so this change is a
draft PR. The lockfile and dependencies are unchanged by issue 7. The inherited
advisories have not been remediated or treated as safe.

## Acceptance evidence

- Four version 1 tools expose typed actor sheet metadata, one section, inventory
  pages, and parent-qualified owned-item detail: `get_actor_sheet`,
  `get_actor_section`, `list_actor_items`, and `get_actor_item`.
  `get_actor_details` version 2 and existing actor/item mutation tools remain
  compatible; the full live suite exercises their existing behavior.
- Unit and built MCP workflow tests use dnd5e 6.0.6 and PF2e 6.2.0 fixtures with
  different schema paths, plus an unknown-system fixture. They preserve zero
  values and missing-field distinctions, distinguish normalized fields from
  system paths, and report unsupported sections. PF2e is synthetic fixture
  evidence, not a claim of live PF2e compatibility.
- Fifteen actor tests run through the built MCP stdio server against real Foundry
  actors and embedded items. Empty and 251-item inventories, page sizes 1, 10,
  and 100, duplicate names, replay, filters, stable IDs/UUIDs, correct parent
  composition, wrong-parent lookup, zero HP/quantity, absent abilities, long
  descriptions, and unusual fields are covered. Responses are checked against
  their advertised JSON schemas and the combined serialization bound.
- Live quantity, sort, item deletion, HP, and actor deletion operations are
  followed by current reads and invalidated-cursor checks. Fresh requests and
  continuations also cover malformed inputs, absent documents, invalid sections,
  tampering, actor/filter/type/limit/tool/session mismatches, and permission
  revocation. Actor deletion rejects all four new read surfaces.
- Delegated live tests create separate player callers and compare parent actor
  visibility with Foundry's permission oracle. Hidden actors and embedded items
  are excluded before counts, records, details, and cursors are serialized.
  Missing and denied documents share generic errors. Description and biography
  content is omitted for delegated callers; unknown-system reads fail closed.
- Foundry 14 embedded Items inherit the parent actor's native permission level.
  MCP applies the additional explicit embedded ownership restriction required by
  issue 4. The live comparison therefore verifies the stricter MCP projection
  separately from the native inherited permission result.
- The complete 178-test live suite covers existing actor, item, token, condition,
  combat, chat, presence, recovery, pagination, REST, compendium, journal, and
  delegated-permission behavior. The 97-test built workflow suite verifies
  discovery, output schemas, authenticated concurrent callers, resources, and
  positive and negative actor requests.
- Fixture cleanup removes test actors, embedded documents, and temporary users
  and restores edited fields. The licensed test world remains running.

## Supported boundary and coverage limits

Each section or owned-item detail returns at most 64 fields, with strings bounded
to 4,096 UTF-16 units and aggregate field values to 8,192 units. Truncation avoids
splitting surrogate pairs. Generic projection visits at most 256 nodes to depth
four and emits only supported primitive values. It omits sensitive fields and
arbitrary nested objects. Inventory defaults to ten records, permits at most 100,
and keeps combined MCP text and structured output within 128 KiB. Cursors bind
the projected content, actor, filters, limit, caller, world, and connection session;
edits, sorting, deletion, and permission changes invalidate affected continuations.

Complete actor reads require the socket backend. The REST adapter explicitly
rejects these operations. Service-mode rich text is sanitized inertly; delegated
reads use the documented conservative field projection rather than raw documents.

`npm run test:reads:coverage` runs the entire unit suite and enforces 100% statements,
branches, functions, and lines for `read-contract.ts` and the actor/item handlers.
It passed all thresholds. These are scoped measurements, not 100% coverage of
the actor profiles, Foundry client, or repository. Positive and negative case
evidence covers the supported contract and named versions above.

## Corrected validation failures

An earlier full live run passed 145 tests and skipped 33 after caller browser
startup and REST compendium setup/cleanup failures. The private REST browser
controller was restarted after it remained stalled. Caller browser contexts now
disable canvas rendering and wait for the authenticated game before reading it.
The focused caller suite subsequently passed 20 tests, and the final full suite
passed all 178 with zero skips. Canvas initialization errors were observed, but
the exact cause of the transient controller failure is unproven.

An initial workflow invocation encountered the sandbox's local-listener
restriction. The authorized local-network invocation passed, and the final built
workflow run passed all 97 tests. No new cross-browser navigation smoke was run;
issue 4's historical Firefox navigation timeout is not represented as a pass.
