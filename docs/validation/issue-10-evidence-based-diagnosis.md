# Issue 10 validation receipt

Validated on 2026-10-09 UTC against the disposable local server at
`http://127.0.0.1:30001`: Foundry VTT 14.369, dnd5e 6.0.6, world `test1world`,
and foundry-rest-api 3.4.1. Foundry uses Node 24.13.1; MCP validation used
Node 26.11.0, npm 11.20.0, and Bun 1.4.2.

The implementation is based on issue 9 commit
`32adee6627e925858200e925a72a7b73aaf53a6f` (draft PR 33). The plan was committed
as `d36c627` and source implementation as `f36138b`. The validation checkpoint
includes built workflow and live tests, and user documentation. Private command
receipts record whether inputs changed during each execution. Raw logs, fixture
credentials, runtime configuration and generated dependencies are not repository
content.

## Results

| Check | Result | Completed UTC |
| --- | --- | --- |
| Full unit suite and scoped read coverage | 1,330 passed, 53 files, zero skipped | 15:06:27 |
| Full live integration suite | 247 passed, 18 files, zero skipped | 15:15:28 |
| Built MCP workflow suite and TypeScript build | 178 passed, five files, zero skipped | 15:06:07 |
| Biome check | Passed; 11 existing warnings | 15:06:12 |
| TypeDoc check | Passed; six warnings | 15:06:21 |
| Executable smoke | Passed | 15:10:01 |
| Dotenv smoke | Passed | 15:10:01 |
| Packed-consumer smoke | Passed | 15:10:18 |
| Dependency audit | Failed: 32 advisories, one critical, 11 high, 18 moderate, two low | 15:10:02 |

The dependency audit remains an unresolved delivery gate, so this change is a
draft PR. Dependencies and the Bun lockfile are unchanged by issue 10. None of
the reported advisories has been remediated or treated as safe.

## Acceptance evidence

- `diagnose_errors` no longer creates an empty error list, an Operational claim,
  a health score or normal-operation recommendations. The advertised strict
  output schema contains only `schemaVersion: 1` and a capability with
  `feature: diagnostics`, `status: unavailable`, reason and remediation.
- The handler and `get_capabilities` use the same frozen unavailable capability
  fact. Default, known, unknown, Unicode, hostile and maximum-length categories
  cannot produce health claims, counts or invented evidence. Missing diagnostic
  evidence is never represented as a clean observation window.
- Both routers and the handler reject wrong types, blank categories, excessive
  lengths, unsupported time/limit fields and other unknown keys with MCP
  InvalidParams. Delegated caller authorization runs first, omits diagnosis
  from discovery and returns InvalidRequest even for malformed arguments.
- Unit and built stdio tests validate advertised schemas through AJV, matching
  JSON text and structured content, strict keys and the shared 128 KiB bound.
  Results contain no category echo, credential, source record or evidence
  metadata. The unavailable handler accesses neither its diagnostic source nor
  its client, and service-identity mode requires no diagnostic API key.
- Built workflow cases prove no diagnostic HTTP requests occur when optional
  REST is absent, available, unauthorized, forbidden, missing, failed, timed out,
  malformed or read-denied. Capability discovery retains its independently
  implemented compendium probe; relay state cannot make diagnosis healthy.
- Seeded compatibility fixtures prove recent-log level/time/limit filters,
  search-result ordering/counts/limits and warning health with supplied metrics
  remain intact. These legacy adapters are not verified Foundry diagnostic
  sources and are not connected to error diagnosis.
- Twenty-five live diagnosis cases run the built MCP entry point with native
  Foundry Socket.IO and with optional REST configured. Independent browser
  status verifies the exact world and server/system versions; native world
  summary confirms world, system version and core generation. An authenticated
  request to the real relay's hypothetical diagnosis endpoint returns 404.
- A controlled live relay failure changes verified compendium availability from
  available to unavailable and back after recovery. Diagnosis remains identically
  unavailable throughout. This was observed during the live run from
  15:09:29–15:15:28 UTC; these are test-run times, not diagnostic evidence times.
  The controller restores the relay in a finally block. No real diagnostic
  failure record or successful diagnosis is claimed because no source exists.
- The full live suite also covers inherited caller-permission, snapshot/recovery,
  actor/item, journal, scene/token, pagination, REST and capability behavior.
  Inherited fixture controllers clean their owned prefixed fixtures and restore
  the prior active scene. The licensed server remains available for further MCP
  testing.

## Supported boundary and coverage limits

Issue 10 explicitly permits marking diagnosis unavailable until a supported
source exists. No verified provider can currently be configured. The paired
relay has no diagnostic endpoint, and the preserved unused legacy
`DiagnosticsClient.diagnoseErrors` method is not a supported source.

The optional `category` must contain nonwhitespace text and have at most 128
UTF-16 code units. Unknown well-formed categories return unavailable; no filter
is applied to records. `timeframe`, `since`, `limit` and other unknown keys are
rejected. Reason and remediation fields are bounded to 512 characters. The
existing capability `verifiedAt` means report time, not diagnostic observation
time or proof of source freshness.

Seeded diagnostic errors, healthy observation windows, stale/partial windows,
malformed records, evidence IDs, observation freshness, category counts and
traceable recommendations are outside this unavailable capability. They are not
claimed as passing provider tests. Legacy log fixture checks establish
compatibility, not successful error diagnosis. Automated repairs remain outside
scope. No cross-browser navigation test was added.

The full unit command enforces 100% statements, branches, functions and lines
across nine modules: `read-contract.ts`, actor/item handlers,
`scene-spatial-contract.ts`, scene handlers, `rule-contract.ts`, rule handlers,
`diagnosis-contract.ts` and `error-diagnosis.ts`: 345/345 statements,
352/352 branches, 58/58 functions and 341/341 lines. The new diagnosis contract
and handler measure 13/13 statements, 2/2 branches, 2/2 functions and 13/13 lines.
These are scoped measurements, not 100% coverage of the client or repository.

## Validation integrity

All final command receipts report unchanged inputs during execution and no
report warning. Required suites contain no skipped tests. The full live run used
explicit private credentials and fixture controllers; no credential or raw
configuration is included here. No failing behavioral test remains. The failed
dependency audit and existing Biome/TypeDoc warnings are reported separately from
passing validation. Final repository additions after these runs consist only of
this validation record.
