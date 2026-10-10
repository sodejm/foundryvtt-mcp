# Issue 4: trusted callers and permission-aware reads

Target: [#4](https://github.com/sodejm/foundryvtt-mcp/issues/4), branch
`codex/issue-4-caller-permissions`, worktree `/private/tmp/foundryvtt-mcp-issue-4`.
Baseline: issue 3 commit `037c03f`; upstream remains v1.5.3 (`23a28b2`).

## Contract

Two explicit authorization modes: `service-identity` (the compatibility default,
one backend identity, never a player gateway) and `delegated` (fail closed).
An embedding host authenticates callers and resolves their Foundry mapping outside
tool arguments. Export `TrustedCallerContext { callerId, userId, worldId, sessionId }`
and a host resolver API. There is no model-supplied role or identity override.
The stdio executable cannot invent an authenticated delegated caller.

`FoundryClient.runWithCaller(context, operation)` scopes an immutable authorized
view with AsyncLocalStorage. Delegated mode requires a connected socket, a fresh
authoritative world ACK, a valid non-banned user in the expected world, and a valid
host context. It revalidates before every MCP read, including cursor continuation.
No stale snapshot or REST fallback may authorize a delegated disclosure. Concurrent
requests must never share caller-derived views. Returned data must not mutate the
privileged cache. Revocation changes authorization bindings and invalidates cursors.

Centralize projection at the client boundary, including `getWorldData`, so direct
client use cannot bypass handler checks. Actor/item reads require OBSERVER or OWNER;
LIMITED does not authorize complete sheets. Respect explicit/default/inherited
ownership and require parent permission for embedded content. Journal pages require
both entry and page permission. Unknown ownership fails closed. Player user lists
contain only the caller and no credential fields. Chat content follows Foundry's
author/whisper/blind visibility; omit whole messages whose content is not visible,
including roll shells. Counts derive from authorized collections only.

Delegate actor, item, journal, chat, own-user and summary reads. Disable scenes,
tokens, combat, compendia, rules, settings, diagnostics and all writes in delegated
mode until their complete visibility or write semantics are demonstrated. This gate
also applies to delegated GMs. Document the conservative restrictions. GM callers
still need valid context and receive only the supported surfaces. Service mode
retains current behavior.

## Work ownership

- Core agent: `src/foundry/client.ts`, `types.ts`, new `caller-context.ts`,
  `pagination.ts` only if required, and focused client/authorization unit tests.
  Deliver public `isDelegatedMode()`, `runWithCaller()`, and
  `assertReadSurfaceAllowed(surface)` APIs. Use generic authorization failures.
- Parent: MCP embedding/server/resolver API, config, router boundary, tool/resource
  discovery, schemas/descriptions, docs, handler and live workflow tests. No edits
  to agent-owned files while it is active.
- Shared worktree, explicit paths when staging. No nested agents. Parent owns all
  remote changes and final integration. Preserve unrelated worktrees and fixtures.

## Validation and delivery

Deterministic positive/negative tests cover missing/malformed/forged context, unknown
user/world/ownership, explicit/default/inherited grants, disjoint players, hidden
embedded data, whispers/blind messages, counts, immutable/concurrent views, denied
surfaces, cursor caller/world/session reuse, permission revocation, disconnect and
refresh failures. Test through client and handler/MCP boundaries, not helpers alone.

Live tests use disposable `test1world` at `http://127.0.0.1:30001`, Foundry 14.369,
dnd5e 6.0.6, modules []. Create owned users/documents and compare with the same users'
actual Foundry permission/visibility results. Clean up only test-owned fixtures.
Exercise allowed/denied tool calls, resource reads, pagination and embedded data.
Record API/UI differences and test counts. Required live tests must not skip.

Run build, unit tests/coverage, lint, docs checks, required integration and built MCP
workflow tests, smoke and package smoke. Coverage claims must state their actual
scope; never equate a case matrix with global 100% branch coverage. Commit concrete
checkpoints, update issue 4, push the dedicated branch, open and attach a PR before
selecting issue 5. Do not merge or close issues without separate authorization.
