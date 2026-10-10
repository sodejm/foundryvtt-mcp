# Issue 4 validation receipt

Validated on 2026-10-09 UTC against the disposable local server at
`http://127.0.0.1:30001`: Foundry VTT 14.369, dnd5e 6.0.6, world `test1world`,
no installed modules. The Foundry runtime uses Node 24.13.1; MCP validation used
Node 26.11.0, npm 11.20.0, and Bun 1.4.2.

## Results

| Check | Result |
| --- | --- |
| Full unit suite with read-contract coverage thresholds | 941 passed, 38 files, zero skipped |
| Read contracts and actor/item read handlers | 100% statements (91/91), branches (107/107), functions (18/18), and lines (91/91) |
| Full live integration suite | 89 passed, 12 files, zero skipped |
| Built MCP workflow suite | 60 passed, two files, zero skipped |
| Playwright browser smoke | Chromium and WebKit passed; Firefox retry timed out before its test ran |
| TypeScript build | Passed |
| Biome check | Passed; 11 existing warnings |
| TypeDoc check | Passed; six warnings |
| Executable, dotenv, and packed-consumer smoke checks | Passed |
| Staged secret scan and lint-staged hook | Passed |
| Dependency audit | Failed: 30 advisories, including one critical, 11 high, and 18 moderate |

The dependency manifest and lockfile are unchanged from the issue 3 base. The
audit remains an unresolved delivery gate. The PR is a draft and this receipt
does not establish merge readiness or treat affected dependencies as safe.
TypeDoc's warnings include the existing warnings plus unresolved references for
the exported read surface and journal creation API.

The browser smoke only checks navigation, HTTP response status, and page title.
Its first run passed Chromium and WebKit, then Firefox stalled and the run was
interrupted. A separate Firefox run reached its 60-second global timeout and
reported one test that did not run. This is not a passing Firefox gate. Feature
validation comes from the live integration and MCP workflow tests above.

## Acceptance evidence

- The exported host resolver receives only immutable SDK authentication and
  transport-session metadata. It supplies a bounded, validated caller/user/world/
  session mapping outside model-controlled tool arguments, resource URIs, and
  request metadata. Missing, throwing, unknown, and forged mappings fail closed.
- Delegated discovery exposes ten read tools and four resource collections.
  Central checks guard both routers, direct handlers, and resource reads before
  arguments or logs can disclose unsupported data. Service-identity mode retains
  its existing tools and resources.
- Each delegated request obtains a fresh authoritative socket snapshot. Actor,
  item, journal/page, embedded document, chat, own-user, search, and world-summary
  projections filter before pagination and serialization. Caller views are
  immutable and isolated with async request context.
- Cursors bind the authorized view to caller, Foundry user, world, and host
  session. Permission changes, membership revocation, reconnects, and view changes
  invalidate prior authorization or cursor reuse. Cursor and authorization
  errors use generic messages; delegated backend failures do not return their
  original payloads.
- Deterministic client and MCP-boundary tests cover default/explicit/inherited
  ownership, malformed evidence, embedded/page restrictions, whispers and blind
  messages, caller concurrency, missing context, forged arguments and metadata,
  unsupported reads and writes, stale/disconnected snapshots, revocation, and
  cross-caller/world/session cursors. The built MCP workflow exercises discovery,
  tools, resources, and SDK error behavior through the actual transport boundary.
- Thirteen live caller tests create a GM and two temporary players with disjoint
  actor, item, embedded item, journal/page, and whisper visibility. They compare
  document projections with Foundry's `testUserPermission(OBSERVER)` and chat
  visibility with each player's live `isContentVisible` value. Search, detail,
  resources, summaries, cursor reuse, permission changes, banned/deleted users,
  and disconnect/reconnect are exercised against the licensed installation.
  Owned documents and users are removed in cleanup; the world remains running.
- Existing live regressions cover actor/item reads and mutations, pagination,
  journal/world resources, tokens, conditions, combat, presence, recovery, and
  health in service-identity mode. The full 89-test suite passed without skips.

## Supported boundary and limits

Delegated mode requires a connected socket backend and rejects REST API-key
configuration. The host authenticates callers; OAuth/JWT validation and campaign
membership storage remain downstream responsibilities. The stdio CLI has no
host resolver and therefore cannot silently grant delegated access.

Ownership evidence is tested at Foundry's OBSERVER level. Full-sheet UI behavior
and system-specific field permissions can differ from document access. Embedded
items require parent and child visibility; journal pages require entry and page
visibility. Blind chat uses a conservative whole-message policy. Scenes, tokens,
combat, compendiums, rules, settings, diagnostics, refresh, and all writes are
disabled in delegated mode, including for a caller mapped to a GM, because their
complete visibility or write semantics have not been established by this issue.

The enforced 100% coverage result applies only to the read-contract and actor/item
handler files named above. It is not a claim of 100% coverage for the entire
client, authorization implementation, game system, or all possible Foundry
configurations. Required positive and negative scenarios are tested within the
documented supported boundary; unsupported surfaces fail closed. No REST module
or alternate game system was installed for this issue.

## Corrected validation failures

A session/world mutation test restores its caller context in `finally` so a failed
assertion cannot change the identity used by subsequent tests. Initial workflow
execution inside the sandbox could not open a local listener; it was rerun with
the authorized local-network permissions and all 60 tests passed.
