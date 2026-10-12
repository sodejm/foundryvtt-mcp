# Unreleased Foundry MCP backlog changes

These notes describe the changes merged into the `sodejm/foundryvtt-mcp` fork
through commit `a6aacbfc5a3011f087c8f63d737bd0d3e4252abf` on 2026-10-12.
The package still declares version **1.5.3**; these changes have no new published
release version. Fork delivery does not establish acceptance by the original
upstream project. [Tracker #14](https://github.com/sodejm/foundryvtt-mcp/issues/14)
remains open for the incomplete pagination and qualification gates below.

## Delivered categories

| Category | Behavior and implementation |
| --- | --- |
| Dependable reads | Actor/item searches and details return stable IDs, source-qualified UUIDs and versioned structured results ([#23](https://github.com/sodejm/foundryvtt-mcp/pull/23)). Native world collection traversal uses bounded immutable snapshots, caller-bound cursors and explicit completion ([#26](https://github.com/sodejm/foundryvtt-mcp/pull/26)); complete REST traversal remains blocked. |
| Long-session reliability | Read metadata distinguishes current, stale and unavailable snapshots. Reconnect and explicit refresh replace the source snapshot; disconnects and world/session changes invalidate continuations ([#27](https://github.com/sodejm/foundryvtt-mcp/pull/27)). |
| Per-caller visibility | An authenticated host supplies trusted caller context; tools, resources, related documents, counts and continuations apply the authorized projection ([#28](https://github.com/sodejm/foundryvtt-mcp/pull/28)). Chat secrecy, session revocation and response bounds were tightened ([#40](https://github.com/sodejm/foundryvtt-mcp/pull/40)); native Player/Trusted service accounts now receive scoped reads and Assistant/GM access requires explicit opt-in ([#49](https://github.com/sodejm/foundryvtt-mcp/pull/49)). |
| Richer world data | Bounded journal summaries compose with complete page text/source ([#30](https://github.com/sodejm/foundryvtt-mcp/pull/30)). Actor sheet sections and parent-qualified inventory details preserve missing values and source paths ([#31](https://github.com/sodejm/foundryvtt-mcp/pull/31)). Scene geometry and token pages expose coordinates, grid footprints and parent-qualified IDs ([#32](https://github.com/sodejm/foundryvtt-mcp/pull/32)). |
| Predictable compendiums | Verified capability statuses distinguish unavailable, unauthorized, unreachable and incompatible support from a successful empty result. Hydrated compendium searches have bounded snapshots and reauthorize continuations ([#29](https://github.com/sodejm/foundryvtt-mcp/pull/29)). |
| Truthful capabilities | Rule lookup and error diagnosis explicitly report unavailable because no verified source is implemented ([#33](https://github.com/sodejm/foundryvtt-mcp/pull/33), [#34](https://github.com/sodejm/foundryvtt-mcp/pull/34)). NPC/loot generation returns local creative previews with `persisted: false` and `rulesVerified: false`, honoring supported inputs without implying system mechanics or world writes ([#35](https://github.com/sodejm/foundryvtt-mcp/pull/35)). These are the scoped outcomes permitted by issues #9–#11. |
| Gameplay breadth | Dice results identify the actual engine, all dice results, active flags and local selection reasons; formulas use a bounded additive/keep/drop subset ([#36](https://github.com/sodejm/foundryvtt-mcp/pull/36)). Item economy adapters distinguish known, missing, invalid, not-applicable and unsupported values and apply rarity filters before totals and pagination ([#37](https://github.com/sodejm/foundryvtt-mcp/pull/37)). |

Supporting corrections remediate dependency/validation findings
([#38](https://github.com/sodejm/foundryvtt-mcp/pull/38)) and fix inherited cache
merges and unsafe HTML handling ([#39](https://github.com/sodejm/foundryvtt-mcp/pull/39)).
Operational changes isolate credentials from PR workflows
([#41](https://github.com/sodejm/foundryvtt-mcp/pull/41)), require protected remote
credential transport ([#42](https://github.com/sodejm/foundryvtt-mcp/pull/42)), pin
the publishing workflow ([#43](https://github.com/sodejm/foundryvtt-mcp/pull/43)),
verify minimized user fields ([#44](https://github.com/sodejm/foundryvtt-mcp/pull/44)),
keep STDIO protocol-only and omit private inputs from logs
([#45](https://github.com/sodejm/foundryvtt-mcp/pull/45)), move sessions out of
Socket.IO URLs ([#46](https://github.com/sodejm/foundryvtt-mcp/pull/46)), save setup
credentials privately ([#47](https://github.com/sodejm/foundryvtt-mcp/pull/47)),
restrict Docker test exposure and rotate admin keys
([#48](https://github.com/sodejm/foundryvtt-mcp/pull/48)), and document/test rootless
remote STDIO hosting ([#50](https://github.com/sodejm/foundryvtt-mcp/pull/50)).

## Compatibility and qualification

| Surface | Evidence and supported boundary |
| --- | --- |
| Native live world | Foundry **14.369**, **dnd5e 6.0.6**, disposable `test1world`. Child receipts cover structured reads, journal content, actor inventory, scene/token geometry, recovery, caller permissions and dice. [Native service-account qualification](../guides/account-permissions.md#verification-and-version-scope) additionally covers Player, Trusted Player and Assistant roles on these exact versions. |
| Optional paired REST | **foundry-rest-api 3.4.1** at `6e00fe28`, **relay 3.4.1** at `c5efd93d`, with an active GM browser. [Capability guide](../guides/optional-capabilities.md) records compendium traversal and key/module revocation evidence. It does not qualify unsupported REST world/item routes or immutable multi-page world snapshots. |
| System adapters | dnd5e **6.0.6** has live evidence. PF2e **6.2.0** actor fixtures and PF2e economy fixtures are synthetic contract evidence, not live PF2e qualification. See [actor validation](../validation/issue-7-bounded-actor-sheet.md) and [economy fixtures](../item-economy-fixtures.md). Other systems retain explicit unsupported fields/sections rather than inferred rules or prices. |
| Additional versions | Foundry 13's historical mutation wire check does not qualify lower-role access. A licensed Foundry 13 lower-role run is still required by [#24](https://github.com/sodejm/foundryvtt-mcp/issues/24). No blanket Foundry/system/module version support is established by the runs above. |

Existing mutation tools remain independently gated by Foundry permissions and
`FOUNDRY_WRITE_ENABLED`; read and preview changes do not implicitly enable writes.
The [account matrix](../guides/account-permissions.md) states minimum native
roles/grants and the cases that still require a privileged process.

## Consumer migration

1. Refresh `tools/list` and validate against its advertised schemas. Read JSON
   from `structuredContent`; matching text is for compatibility. Search using
   stable `record.id`, then request detail with that ID. Names are not keys;
   use UUIDs only when the source establishes them. Actor search/detail schemas
   are versions **3/2**, item search/detail **4/3**, actor sheet/section **1** and
   owned-item inventory/detail **2**. See [read contracts](../../README.md#structured-actor-and-item-reads).
2. Replace numeric pagination inputs with opaque `nextCursor`. Keep query,
   filters and limit unchanged, and continue until `complete: true`; a short
   page alone does not prove completion. On expiry, revocation or
   reconnect, restart the traversal. Service-identity collection snapshots retain
   their captured records across ordinary edits; delegated authorization changes
   and child-document mutations can invalidate their continuations. Do not confuse the collection `snapshotId`
   with `readMetadata.snapshotId`, which identifies its source snapshot.
3. Use journal page IDs for complete content, actor IDs plus owned-item IDs for
   inventory detail, and scene IDs plus token IDs for spatial detail. Summaries,
   projected sheet sections and raw page source have different bounds. Treat
   HTML/Markdown source as inert data. The [journal](../validation/issue-6-complete-journal-pages.md),
   [actor](../validation/issue-7-bounded-actor-sheet.md) and
   [spatial](../validation/issue-8-scene-token-reads.md) receipts describe limits.
4. Configure a dedicated Player/Trusted account and explicit document grants for
   scoped native service reads. Existing Assistant/GM and paired REST deployments
   must explicitly set `FOUNDRY_ALLOW_PRIVILEGED_ACCOUNT=true`. Keep privileged
   credentials in a separate process. Multi-user delegated access additionally
   needs an authenticated host resolver; a model-supplied user ID is not trusted
   identity. STDIO alone does not supply that resolver. See
   [configuration](../guides/configuration.md) and [account permissions](../guides/account-permissions.md).
5. Inspect capability status before optional operations. Unavailable rule lookup
   or diagnosis is not a match, a clean log window or healthy server. Treat
   generated NPC/loot values as [creative previews](../guides/content-generation.md),
   not document creation payloads or verified treasure valuations.
6. For [dice](../guides/dice.md), inspect `engine` and `fallback`. Default `auto`
   evaluates locally. Select `foundry` explicitly with privileged paired REST
   configuration for remote evaluation; a remote failure never silently rerolls
   locally. Unsupported notation fails before evaluation. Consume economy
   status and source metadata instead of assuming missing prices are zero or
   unknown systems use D&D currency.
7. Remote credential-bearing Foundry/REST URLs require protected transport;
   loopback remains suitable for local testing. Remote hosting uses
   [SSH STDIO](../guides/remote-stdio.md); no public MCP HTTP endpoint is added.

## Remaining limits and release gates

Native pages default to 10 records and permit at most 100. Continuations expire
in five minutes and bind to the query, caller, world and session. Shared bounded
read results include a 128 KiB combined text/structured serialization limit;
individual contracts impose additional field and snapshot capacity bounds.
Capacity failures require a narrower request, not an unbounded response.

- [#2](https://github.com/sodejm/foundryvtt-mcp/issues/2): the external REST backend
  lacks the immutable `snapshotId` contract needed to prove complete multi-page
  world traversal. Controlled fixtures do not establish live backend support.
  Rich journal, sheet and spatial reads require native Socket.IO.
- [#15](https://github.com/sodejm/foundryvtt-mcp/issues/15): credential isolation
  code is delivered, but a trusted hosted integration run with configured scoped
  credentials and inspected logs/artifacts remains unqualified. A skipped job
  does not pass this gate.
- [#17](https://github.com/sodejm/foundryvtt-mcp/issues/17): publishing workflow
  pinning is delivered; owner-side trusted-publisher binding and current release
  provenance still require qualification. These notes authorize no publication.
- [#24](https://github.com/sodejm/foundryvtt-mcp/issues/24): qualify lower-role
  permissions on licensed Foundry 13 before extending the live version matrix.
- [#14](https://github.com/sodejm/foundryvtt-mcp/issues/14): retain the final
  cross-surface permission, contract and runtime validation gate until the
  applicable outstanding criteria have evidence.

Rule lookup and diagnosis have no verified provider. Creative generation is
local and unpersisted. Delegated mode hides/denies unverified surfaces and dice.
Compendium relay request IDs are serialized within a process; concurrent
independent processes retain the documented collision limitation. Legacy
`FOUNDRY_API_KEY` routing does not establish paired relay capability.
LegendForge authentication, campaign membership and cloud deployment stay
outside this reusable adapter.

## Validation evidence

The linked child receipts and merged PRs are historical evidence for their
revisions, not new runs of this release candidate. In particular, early actor,
recovery and spatial receipts record audit failures that were subsequently addressed by
PRs #38–#39; those receipts remain preserved as historical records.

PR #49 records 1,808 passing unit tests, 791 built workflow cases and three
native lower-role permission cases on Foundry 14.369 / dnd5e 6.0.6. PR #50
records 1,809 passing unit tests, 791 workflow cases, build, lint, documentation
and three package/STDIO smoke checks. Its SSH lab is synthetic remote-host
qualification, not another Foundry-version run. The release-notes PR will record
fresh checks of this documentation revision. Re-run affected live suites on the
final candidate and record exact versions before closing tracker #14.
