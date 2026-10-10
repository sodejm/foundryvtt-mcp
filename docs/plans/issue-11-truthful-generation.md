# Issue 11: truthful NPC and loot generation

## Baseline and scope

Based on issue 10 head `cdc69ac4d9f7c8645907e295e7b48da41df98f46` (draft PR 34).
Rechecked upstream on 2026-10-09: main remains
`23a28b2ee8031997e37de855493ecb73f5147a92`, v1.5.3; no matching generation-title
issue was found. Existing handlers produce local scaffolding: NPCs include
unverified D&D mechanics, loot ignores treasure type and reports a value that
cannot be derived from its currency and items.

Implement the issue's creative-preview option. No verified system adapter,
rules-valid mode, implicit mutation, or source-table import is introduced.
Preserve separate mutation tools and delegated caller restrictions.

## Contract and implementation

- Publish strict versioned structured NPC/loot results and matching bounded JSON
  text. Identify creative-preview mode, preview status, no persistence, no rules
  verification, supported options and limitations. System/version are inapplicable
  to a world-independent creative mode. Never return fabricated document IDs.
- Validate every advertised option and reject unknown keys with InvalidParams.
  NPC level is an integer from 1 through 20; race/class are bounded nonblank
  narrative labels. Loot challenge rating is a finite creative scale from 0
  through 30; treasure type supports individual and hoard. Defaults are explicit.
  Every accepted input affects generated content or scaling; no option is ignored.
- Produce system-neutral narrative NPCs without inferred combat statistics or
  unexplained D&D defaults. Inject randomness for deterministic handler tests.
- Give individual and hoard distinct loot quantities. Explain any fictional
  currency conversion, calculate the known currency subtotal from returned
  denominations, and report unknown item valuations and overall total explicitly.
  No invented market values or verified-world currency claims.
- Keep verified system-specific content generation unavailable in capability
  discovery while explicitly explaining the available local creative previews.
  Update schemas, descriptions, examples and compatibility notes together.

## Verification and delivery

Source tests cover deterministic RNG branches, supported input variations,
boundaries/wrong types/unknown keys, unsupported systems, arithmetic, unknown
valuation and zero client/mutation access. Enforce 100% coverage on new contract
and generation handlers without claiming whole-repository coverage. Built MCP
workflow and real-server integration validate discovery, schemas, JSON parity,
authorization, preview status and positive/negative calls. Record Foundry core,
system and module versions and all baseline failures.

Run full units, build/workflows, lint, docs, executable/dotenv/packed-consumer
smokes and live integrations. Preserve private fixtures and unrelated dirty work.
Commit meaningful checkpoints, scan outgoing secrets, publish the authorized
stacked draft PR and issue update before starting the next issue. Unresolved
dependency-audit or review gates remain visible; do not claim merge readiness.
