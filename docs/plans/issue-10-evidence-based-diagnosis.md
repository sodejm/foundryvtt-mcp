# Issue 10: evidence-based error diagnosis

## Scope and baseline

Issue: https://github.com/sodejm/foundryvtt-mcp/issues/10

Branch `codex/issue-10-evidence-based-diagnosis`, worktree `/private/tmp/foundryvtt-mcp-issue-10`, base `32adee6627e925858200e925a72a7b73aaf53a6f` from issue 9. Upstream main remains `23a28b2ee8031997e37de855493ecb73f5147a92` (v1.5.3). Issue 9 was published as draft PR #33 before selecting this issue. Main checkout is preserved.

`diagnose_errors` currently fabricates an empty error list, reassuring recommendations and an Operational status. Its DiagnosticSystem argument has no error-diagnosis method. A separate legacy DiagnosticsClient requests a hypothetical `/api/diagnostics/errors` route, but there is no verified adapter, provenance/coverage contract or endpoint implementation. The local REST relay 3.4.1 source and OpenAPI contain no diagnostic routes, and a live GET to that route returns 404. Upstream DEF-4 issue #133 is closed; its description explicitly allows an honest stub. Issue 10 explicitly permits unavailable diagnosis until a supported source exists.

## Intended behavior

- Preserve `diagnose_errors` and optional `category`, with a strict bounded nonblank category and unknown-key rejection in both routers and handler. Unknown well-formed categories are accepted and produce unavailable, because no category classification or filtering is implemented. Timeframe, since and limit are unsupported and rejected rather than silently ignored.
- Replace the fabricated diagnosis with strict versioned structured JSON and matching bounded JSON text. Report diagnostics unavailable with a specific reason and remediation; omit error counts, health scores, system status, suggestions and evidence timestamps/IDs because none were observed. Do not interpret absence of evidence as a clean window or healthy server.
- Share the static unavailable fact with `get_capabilities`. Diagnosis performs no source access, probes, log retrieval or network work and never echoes category, credentials or private data.
- Keep delegated authorization first, including denial before argument parsing, and preserve discovery filtering. Preserve existing health, log, metrics and connection behavior. Keep the unused legacy DiagnosticsClient API unchanged for compatibility; do not connect it to diagnosis without an evidence contract.
- Do not implement a provider, automatic repairs, real category/time filtering, evidence indexing, freshness evaluation or unsupported error ingestion. Source-specific seeded/clean/stale/partial/malformed records and source failure/recovery cannot be asserted without a provider. Exercise unavailable diagnosis across controlled relay failures and recovery through actual MCP, documenting this boundary rather than claiming observed diagnostic evidence.

## Ownership and validation

Reuse the existing implementation agent (gpt-5.6-sol/high) for source and source unit tests only. Parent owns plan/validation documentation, built stdio workflow and licensed local integration tests, commits, review and publication. Record the contract, task claim/heartbeat and handoff in the existing project workboard. Agree the public schema before parent tests.

Cover default/category/unicode/maximal/unknown-category inputs, malformed/oversized/unsupported parameters, absence of fabricated health and counts, exact text/structured parity, advertised input/output schemas, no source access under hostile source states, capability agreement, authorization in both routers and unchanged health/log behavior. Enforce 100% statements/branches/functions/lines for new diagnosis contract and handler and retain prior strict read coverage. Run full unit and workflow suites, all licensed local integration tests with zero skips, build, lint, docs, executable/dotenv/package smoke checks, locked dependency audit and outgoing secret scan with validation receipts.

Use Foundry 14.369 / dnd5e 6.0.6 / test1world at http://127.0.0.1:30001/game and existing relay/control fixtures; never expose their credentials. Commit plan, implementation and validation checkpoints separately. Publish an attached draft PR stacked on issue 9 and update issue 10 before selecting the next issue. Existing locked dependency advisories remain a merge gate; publication is not closure or merge readiness.
