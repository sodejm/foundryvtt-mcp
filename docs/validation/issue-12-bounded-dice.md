# Issue 12 validation receipt

Validated on 2026-10-09 UTC against the disposable local server at
`http://127.0.0.1:30001`: Foundry VTT 14.369, dnd5e 6.0.6, world `test1world`,
and foundry-rest-api 3.4.1. Foundry uses Node 24.13.1; MCP validation used
Node 26.11.0, npm 11.20.0 and Bun 1.4.2.

The implementation is based on issue 11 commit
`b3baa1474471ca08973b1481c872b6c057017a2b` (draft PR 35). The final live run
uses commit `169e287`, which includes the journal fixture readiness check and
TypeDoc export registration. Private receipts record command inputs and whether
they changed during execution. Credentials, raw runtime configuration, fixture
files and generated dependencies are not repository content.

## Results

| Check | Result | Completed UTC |
| --- | --- | --- |
| Full unit suite and scoped coverage | 1,457 passed, 57 files, zero skipped | 18:09:05 |
| Full live integration suite | 515 passed, 20 files, zero skipped | 18:27:57 |
| Built MCP workflow suite and TypeScript build | 809 passed, seven files, zero skipped | 18:09:35 |
| Biome check | Passed; 11 existing warnings | 18:08:47 |
| TypeDoc check | Passed; six existing warnings | 18:20:34 |
| Executable smoke | Passed | 18:09:55 |
| Dotenv smoke | Passed | 18:09:52 |
| Packed-consumer smoke | Passed | 18:10:04 |
| Dependency audit | Failed: 32 advisories, one critical, 11 high, 18 moderate, two low | 18:09:57 |

The dependency audit remains an unresolved delivery gate, so this change is a
draft PR. Dependencies and the Bun lockfile are unchanged by issue 12. No reported
advisory has been remediated or treated as safe.

## Acceptance evidence

- The same complete bounded grammar applies to local and native execution:
  integer constants, dice, addition/subtraction, unary signs, parentheses and
  one `kh`, `kl`, `dh` or `dl` modifier per dice term. Whole-input parsing rejects
  unsupported constructs and trailing junk before randomness or HTTP. No formula
  is evaluated as JavaScript. The grammar, defaults, Foundry drop-all behavior,
  normalization and compatibility boundary are documented in
  [`dice.md`](../guides/dice.md).
- Explicit local execution avoids HTTP. Auto without a dice transport returns
  local results with a truthful fallback reason. Configured auto/native execution
  uses the paired REST transport once with chat creation disabled. Partial REST
  or legacy-only configuration fails explicitly; complete paired configuration
  takes precedence. Authentication errors, malformed responses, disconnects and
  uncertain completion remain errors without retries or local rerolls.
- The strict versioned result reports actual engine, normalized formula,
  per-die values and active flags, integer total, breakdown, timestamp, optional
  reason and fallback provenance. JSON text matches `structuredContent`; AJV
  checks the advertised schema through built MCP. The adapter validates native
  counts, faces, value ranges, modifier selection and total consistency. Invalid
  inputs preserve MCP InvalidParams behavior; delegated callers are denied
  before execution, including when their arguments are malformed.
- Resource checks cover 100 input characters, 999 dice per term, 1,000 aggregate
  dice, 50 terms, ten parenthesis levels, 1,000,000 faces and bounded integer
  constants/arithmetic. Splitting dice across terms cannot bypass the aggregate
  limit. Rerolls, explosions, pools, variables and arbitrary scripting remain
  unsupported and are rejected.
- The dice workflow suite contains 570 cases using built stdio MCP, real local
  HTTP fixtures and strict schema checks. It covers engine/configuration choices,
  malformed input and responses, authorization, request limits, redaction and
  one-attempt failure behavior. The live dice suite contains 209 cases using
  official Foundry execution and the real paired module/relay.
- Official engine comparisons use identical controlled random values for all
  37 valid formula fixtures and four explicit modifier tie fixtures. They compare
  consumed randomness, individual values, active flags and total; independently
  random totals are not treated as parity evidence. The oracle restores Foundry's
  random source. Real disconnect and timeout tests prove the remote roll completed
  exactly once while MCP returned an error, with no chat message or reroll.
- The full live suite also covers inherited structured reads, pagination,
  snapshot recovery, caller permissions, actor/item, journal, scene/token, REST,
  rule, diagnosis and generation behavior. Fixture controllers clean their owned
  prefixed data and restore the prior active scene. The licensed server remains
  available for subsequent MCP testing.

## Coverage and supported boundary

The full unit command enforces 100% statements, branches, functions and lines
across fifteen selected modules: 643/643 statements, 547/547 branches,
104/104 functions and 631/631 lines. The four dice modules (`dice-formula.ts`,
`dice-contract.ts`, `rest-dice.ts` and the dice handler) measure 234/234 statements,
169/169 branches, 38/38 functions and 227/227 lines. These are scoped measurements,
not 100% coverage of the full Foundry client or repository.

The supported notation is deliberately bounded. Native Foundry supports wider
syntax; the MCP contract does not promise it. The older text-only roll response
changes to a strict structured result. Legacy-only transports cannot establish
complete provenance and must migrate to paired REST or explicitly select local
execution. Controlled parity is verified at the versions recorded above.

## Validation integrity

Final receipts report unchanged inputs during each command and no report warning.
Required suites contain no skipped tests. An earlier full live run passed 514 of
515 cases and failed one journal cursor test when it read a newly reseeded journal
before the creation broadcast reached a separate Socket.IO client. The unchanged
journal suite passed in isolation. A bounded seed-readiness poll now precedes the
mutation assertions; those assertions still verify both cursor families and the
actual document mutation. The fixed journal suite passed all 54 cases, followed
by the full rerun reported above. The earlier failed run is not counted as passing
validation.

The final live run executed from 18:20:58 through 18:27:57 UTC using
explicit private credentials and fixture controllers. The failed dependency audit
and existing Biome/TypeDoc warnings are separate from passing behavioral checks.
Repository additions after the final live run consist only of this validation
record.
