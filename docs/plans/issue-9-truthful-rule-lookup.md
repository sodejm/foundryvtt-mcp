# Issue 9: truthful rule lookup

## Scope and baseline

Issue: https://github.com/sodejm/foundryvtt-mcp/issues/9

Branch `codex/issue-9-truthful-rule-lookup`, worktree `/private/tmp/foundryvtt-mcp-issue-9`, base `a12e4b5161fb27d95eb6438e87878469f916b80c` from issue 8. Upstream main was rechecked at `23a28b2ee8031997e37de855493ecb73f5147a92` (v1.5.3). Main checkout is clean and preserved. Prior draft PRs remain open.

`lookup_rule` currently constructs a rule title, mechanics and invented Core Rulebook citation without retrieving anything. `get_capabilities` already reports rulesLookup unavailable. No verified rule provider or source-content retrieval adapter exists. Issue 9 explicitly accepts a truthful unsupported implementation for systems without a provider.

## Intended behavior

- Preserve the tool name and query/system argument names, remove the invented D&D default, generated rule content and fabricated source citation.
- Strictly validate a nonblank bounded query, optional nonblank bounded system and unknown keys in both routers and handler. Invalid input returns MCP InvalidParams before work.
- Return a versioned strict JSON output schema through structuredContent and matching bounded JSON text. The result reports rulesLookup unavailable with an explicit reason/remediation, and does not contain results, totals, source references or generated mechanics that imply retrieval.
- Keep capability discovery and lookup consistent by sharing the static unavailable capability fact. Valid queries, all systems and nonsense produce unavailable, never a fabricated successful match, no-match or ambiguity.
- Preserve delegated caller denial and discovery filtering. Unsupported lookup performs no network, journal, pack, source-page or proprietary-content access. No provider is advertised. Successful retrieval/no-match/ambiguity, source denial and provider timeout are not observable states without an implemented provider; document this explicitly.
- Keep creative NPC/loot helpers separate and unchanged. Do not broaden dependencies, content generation, diagnostics or compendium retrieval.

## Ownership and validation

Existing bounded implementation agent owns source code and source unit tests only. Parent owns plan/validation documentation, workflow/live tests, commits and publication. Agree the public schema before parent tests are written; record workboard claim/heartbeat/handoff.

Tests must cover valid default/custom/system/nonsense queries, maximal and malformed inputs, no source invention, parity of JSON text and structuredContent, strict advertised schemas, capability agreement, both routers, delegated denial, and absence of provider access. Enforce 100% statements/branches/functions/lines for the new rule contract/handler and meaningful positive/negative cases. Run full unit, workflow and licensed local integration suites with zero skips, build, lint, docs, executable/dotenv/pack smoke checks, audit and outgoing secret scan with validation receipts.

The local server is Foundry 14.369 with dnd5e 6.0.6 at http://127.0.0.1:30001/game; REST fixture 3.4.1 and test controllers remain available. Only owned fixture content may be changed. Never expose private fixture credentials.

Commit the plan, implementation and validation checkpoints separately. Push and create an attached draft PR stacked on issue 8 after local checks, then update issue 9 before selecting issue 10. Existing dependency advisories remain a merge gate unless separately resolved; do not claim draft publication is completion, merge readiness or closure.
