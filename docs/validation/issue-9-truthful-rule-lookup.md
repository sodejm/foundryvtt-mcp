# Issue 9 validation receipt

Validated on 2026-10-09 UTC against the disposable local server at
`http://127.0.0.1:30001`: Foundry VTT 14.369, dnd5e 6.0.6, world `test1world`,
and foundry-rest-api 3.4.1. Foundry uses Node 24.13.1; MCP validation used
Node 26.11.0, npm 11.20.0, and Bun 1.4.2.

The implementation is based on issue 8 commit
`a12e4b5161fb27d95eb6438e87878469f916b80c` (draft PR 32). The plan was committed
as `12538cd` and the source implementation as `e2e2873`. The final checks include
workflow and live tests, and user documentation. Each final command's private
receipt reported unchanged inputs during its execution. Raw logs, runtime
configuration and fixture credentials are not repository content.

## Results

| Check | Result | Completed UTC |
| --- | --- | --- |
| Full unit suite and scoped read coverage | 1,282 passed, 50 files, zero skipped | 14:23:49 |
| Full live integration suite | 222 passed, 17 files, zero skipped | 14:34:49 |
| Focused live rule and capability integration | 38 passed, two files, zero skipped | 14:27:31 |
| Built MCP workflow suite and TypeScript build | 144 passed, five files, zero skipped | 14:21:18 |
| Biome check | Passed; 11 existing warnings | 14:23:38 |
| TypeDoc check | Passed; six warnings | 14:35:02 |
| Executable smoke | Passed | 14:23:39 |
| Dotenv smoke | Passed | 14:23:39 |
| Packed-consumer smoke | Passed | 14:29:03 |
| Dependency audit | Failed: 32 advisories, one critical, 11 high, 18 moderate, two low | 14:26:36 |

The dependency audit remains an unresolved delivery gate, so this change is a
draft PR. Dependencies and the Bun lockfile are unchanged by issue 9. None of
the reported advisories has been remediated or treated as safe.

## Acceptance evidence

- `lookup_rule` no longer generates mechanics, chooses an invented D&D default,
  or returns a fabricated Core Rulebook citation. Its advertised strict output
  schema contains only `schemaVersion: 1` and a capability with
  `feature: rulesLookup`, `status: unavailable`, reason and remediation.
- The handler and `get_capabilities` share the same frozen unavailable capability
  fact. Valid default/custom-system queries, common rule names, broad terms,
  nonsense, unknown systems and wrong-version system names return unavailable;
  they cannot masquerade as successful retrieval, ambiguity or a no-match result.
- Both routers and the handler reject missing, blank, malformed, excessive and
  unknown-key inputs with MCP InvalidParams. Delegated caller authorization runs
  first, omits this tool from discovery and returns InvalidRequest even for
  malformed lookup input.
- Advertised schemas are checked through AJV and built MCP stdio clients. JSON
  text and structured content match, keys are strict, output remains within the
  shared 128 KiB serialization bound, and output contains no query echo, source
  reference, rule content or private fixture credentials.
- Source unit tests prove the unsupported handler never accesses its client.
  Built workflow cases cover optional REST being absent, available, denied,
  missing, failed, timed out or malformed without any lookup HTTP request.
  Capability discovery still probes its separately implemented compendium
  feature; rule lookup remains unavailable regardless of that result.
- Twenty-five live rule cases use the built entry point with native Foundry
  Socket.IO and with optional REST configured. A separate browser controller
  verifies the world and exact server/system versions; native world summary
  confirms the world, system version and core generation. The full integration
  suite also checks inherited actor, item, journal, scene/token, pagination,
  recovery, REST and caller-permission behavior.
- Rule lookup performs no source-page, journal, compendium or proprietary-content
  access. Its live cases do not mutate world data. Inherited fixture controllers
  clean owned prefixed fixtures and restore the prior active scene; the licensed
  local server remains available for subsequent MCP work.

## Supported boundary and coverage limits

Queries must contain nonwhitespace text and have at most 256 characters. The
optional system string has the same nonblank requirement and at most 128
characters. Unknown input keys are rejected. Reason and remediation fields are
bounded to 512 characters. The tool returns unavailable for every valid input
because no verified provider exists or can currently be configured.

Issue 9 explicitly permits truthful unsupported behavior. There are no supported
rule retrieval results, resolvable citations, source IDs or source-content
visibility claims. Provider-specific successful retrieval, no-match, ambiguity,
source denial and timeout fixtures are not applicable to this implementation.
Malformed input and delegated authorization denial are distinct tested MCP errors;
backend failures do not change the verified absence of a rule provider.

The full unit command enforces 100% statements, branches, functions and lines
across `rule-contract.ts`, rule handlers, `scene-spatial-contract.ts`, scene
handlers, `read-contract.ts`, and actor/item handlers: 332/332 statements,
350/350 branches, 56/56 functions and 328/328 lines. The new rule contract and
handler measure 14/14 statements, 2/2 branches, 2/2 functions and 14/14 lines.
These are scoped measurements, not 100% coverage of the Foundry client or
repository. Case evidence establishes the supported unavailable contract on
the versions above.

## Corrected validation failures

The first focused live run passed 37 of 38 tests. Its world-summary assertion
expected the full build number, but that established summary reports the core
generation. The assertion now compares the independent exact version's generation
and still verifies the world and system version. The corrected focused run passed
all 38 tests before the full run above.

Initial workflow and packed-consumer attempts encountered sandbox restrictions
on local listeners and npm cache access. Authorized reruns passed all 144 workflow
tests and the consumer smoke without changing cache ownership. An earlier unit
coverage invocation misspelled the spatial-contract include; the final command
uses the correct path and measures all seven intended modules. No new
cross-browser navigation smoke or rule-provider retrieval test was run.
