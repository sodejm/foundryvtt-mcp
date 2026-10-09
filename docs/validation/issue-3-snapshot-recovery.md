# Issue 3 validation receipt

Validated on 2026-10-09 UTC against the disposable local server at
`http://127.0.0.1:30001`: Foundry VTT 14.369, dnd5e 6.0.6, world `test1world`,
no installed modules. The Foundry runtime uses Node 24.13.1; the MCP validation
commands used Node 26.11.0, npm 11.20.0, and Bun 1.4.2.

## Results

| Check | Result |
| --- | --- |
| Full unit suite with read-contract coverage thresholds | 795 passed, 36 files, zero skipped |
| Read contracts and actor/item read handlers | 100% statements (91/91), branches (107/107), functions (18/18), and lines (91/91) |
| Live integration suite | 76 passed, 11 files, zero skipped |
| Built MCP stdio workflow suite | 45 passed, zero skipped |
| Playwright browser harness | Chromium and WebKit passed; Firefox did not complete |
| TypeScript build | Passed |
| Biome check | Passed; 11 existing warnings |
| TypeDoc check | Passed; three existing warnings |
| Executable, dotenv, and packed-consumer smoke checks | Passed |
| Staged secret scan and lint-staged hook | Passed |
| Dependency audit | Failed: 30 advisories, including one critical, 11 high, and 18 moderate |

The dependency manifest and lockfile are unchanged from the issue 2 base. The
audit remains an unresolved delivery gate; this receipt does not treat it as a
passing check or establish that the affected packages are unexploitable.

The browser harness only checks page navigation, response status, and the page
title. Its first run passed Chromium and WebKit, but Firefox stalled and the run
was interrupted. Firefox was retried with an explicit 60-second global timeout;
its result is not a passing browser gate. Feature validation is supplied by the
real MCP integration and workflow suites above, not by this browser smoke.

## Acceptance evidence

- Deterministic client tests cover stable source clocks, absent versus empty
  snapshots, stale reads, coalesced recovery, timeout and malformed ACK retries,
  bounded buffer overflow, buffered document and presence events, reconnect and
  world/session changes, retired ACKs, mutation ACK fencing, cursor invalidation,
  and listener cleanup.
- Handler tests cover current/stale/unavailable policies for document details,
  legacy world tools, resources, and health. REST diagnostics retain their own
  capture/observation/response clocks and cannot mark a socket snapshot current.
- The real MCP stdio recovery workflow interrupts only the reader's TCP
  connection. A separate authenticated writer changes an actor and brings a
  temporary player online during the outage. It verifies retained stale data,
  stale presence, invalidated cursors, recovered document/presence state, a new
  source snapshot, and session fencing after explicit disconnect/reconnect.
- Live regression tests exercise actor/item reads, duplicate and missing IDs,
  pagination over 251 actors and 251 items, journal/world collections,
  resources, token movement and conditions, item/currency mutations, combat,
  presence, and health. Mutation fixtures are owned by the test, require
  `test1world`, and are deleted or restored during cleanup.
- MCP workflow tests validate advertised output schemas and pagination source
  provenance. Replaying a page retains its source clocks and only advances the
  response clock; superseded pages are labelled stale.

## Limits and corrected failures

The 100% enforced coverage result applies to the read-contract and actor/item
handler files listed above. It is not a claim of 100% branch coverage for the
entire client: the focused refresh/ACK section covers 43/51 branches (84.31%).
Required positive and negative scenarios are exercised by deterministic tests;
synthetic races and malformed ACKs are not induced by modifying the licensed
Foundry server. Live testing covers the versions and socket transport listed
above; no REST API module or other game system was installed.

An initial live recovery run exposed an ordering assumption in the test:
Foundry's batch create ACK can return actors in a different order from the
request. The fixture now identifies the requested actor by its returned name
and tracks every returned ID for cleanup. The complete live suite then passed.
