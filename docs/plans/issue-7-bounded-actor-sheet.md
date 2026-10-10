# Issue 7: bounded actor sheet and owned-item reads

Issue: https://github.com/sodejm/foundryvtt-mcp/issues/7

Branch: `codex/issue-7-bounded-actor-sheet`, based on issue 6 commit
`79a89fd6c78f8aa774eebbb23f93926aa6ccc51f`.
Upstream HEAD was rechecked before implementation and remains
`23a28b2ee8031997e37de855493ecb73f5147a92`.

## Contract and implementation

Keep `get_actor_details` compatible. Add four typed, versioned read tools:

- `get_actor_sheet`: actor identity, system ID/version, supported sections and
  field metadata, inventory count, and explicitly unsupported sections.
- `get_actor_section`: one bounded section, preserving missing fields and zero
  values, with explicit normalized versus system-path provenance.
- `list_actor_items`: bounded inventory pages with parent actor ID/UUID and
  stable embedded item IDs/UUIDs.
- `get_actor_item`: bounded detail for an item resolved only within its actor.

Use the existing structured read contract, read metadata and paginator. Limits
must cover source traversal, field count, string length, page size and the complete
serialized response. Invalid IDs, sections, limits and cursors fail before lookup.
Continuation cursors bind caller, session, actor, query and projected content;
edits, sorting, deletion and permission changes invalidate affected continuations.

Use explicit system profiles for documented dnd5e and PF2e fixtures with different
schemas. An unknown-system fallback provides a bounded primitive system-path
projection, with conservative field visibility, explicit omissions and no raw
document dump. The public contract never includes flags, ownership, credentials,
prototype tokens or arbitrary nested objects. Delegated reads require both actor
and embedded-document visibility before serialization. Unsupported or unverified
field visibility fails closed. REST support is explicitly unavailable where the
backend cannot prove this contract.

Existing mutation tools remain unchanged, except descriptions can now point to
the new inventory read for owned-item IDs.

## Ownership and checkpoints

The core implementation agent owns `src/` and unit tests under `src/`. The parent
owns this plan, `scripts/`, `tests/integration/`, `tests/workflows/`, README and
documentation. Both use this isolated worktree with disjoint file ownership; only
the parent commits. The agent reports the proposed public schemas early so the
parent can implement workflow and live tests against them.

Commit the plan, contract/runtime implementation, and validation/documentation at
separate meaningful checkpoints. Update the issue when claimed and when a draft
PR is published. Publish the PR before proceeding to issue 8. Do not merge or close
the issue without separate authority and verified delivery state.

## Acceptance and validation

Unit and handler/client tests cover every advertised input and output branch:
empty and 251-item inventories, duplicate names, stable parent/item composition,
wrong-parent lookup, zero HP and quantity, absent abilities, long descriptions,
unusual fields, normalized profiles and unknown fallback, unsupported sections,
bounded projection, malformed source data, missing/deleted documents, actor and
embedded permission denial, secret omission, cursor tampering, expiry and changes.

Workflow tests use the built MCP server, validate advertised JSON schemas and
response bounds, compose inventory into item detail, and verify delegated tool
discovery, caller isolation and denied data.

Live tests use only the disposable `test1world` at
`http://127.0.0.1:30001`: Foundry 14.369, dnd5e 6.0.6 and active
foundry-rest-api 3.4.1. A loopback fixture controller creates named test actors and
embedded items, performs fixed updates/deletions and cleans its fixtures. Test
post-update/deletion reads and permission negatives. PF2e is a documented synthetic
fixture, not a claim of live compatibility. All required integration tests must run
without skips.

Run build, unit tests with coverage, workflows, live integration, lint, docs check,
smoke, dotenv smoke and package smoke. Record exact commits, test counts, versions,
positive/negative case coverage and limitations. Do not conflate complete planned
case coverage with 100% repository line or branch coverage. Check the outgoing
diff for secrets and report inherited dependency audit failures separately.
