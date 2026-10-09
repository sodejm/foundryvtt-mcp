# Issue 12: bounded dice evaluation and engine provenance

## Baseline and scope

Based on issue 11 head `b3baa1474471ca08973b1481c872b6c057017a2b`
(draft PR 35). Upstream main was rechecked on 2026-10-09 and remains
`23a28b2ee8031997e37de855493ecb73f5147a92`. The current local parser handles
whole additive expressions, but rejects parentheses and modifiers. The legacy
REST path catches execution failures and silently rolls locally.

Extend the shared bounded grammar with parentheses and a single keep/drop
modifier (`kh`, `kl`, `dh`, `dl`) on each dice term. Support integers, dice,
addition/subtraction and bounded unary signs. Reject multiplication, variables,
rerolls, explosions, pools, chained modifiers and all trailing junk explicitly.
Verify modifier defaults, ties and limits against Foundry 14.369 before claiming
parity. Combat automation and arbitrary scripting remain outside this issue.

## Contract and implementation

- Parse and validate the entire expression before randomness or server access.
  Enforce 100 input characters, 999 dice per term, 1,000 aggregate dice, 50 terms, 10 parenthesis
  levels, at most 1,000,000 sides and safe bounded integer arithmetic. Preserve
  existing valid simple expressions wherever Foundry semantics permit.
- Publish strict versioned structured results and equivalent bounded JSON text:
  actual engine, normalized formula, per-die outcomes/active flags, total,
  breakdown, timestamp, optional reason and explicit fallback provenance.
- Accept `auto` (default), `local` and `foundry` execution choices. Explicit local
  execution never calls a server. Auto uses local execution only when no dice
  transport is configured, and reports that reason. Foundry-required execution
  without configuration fails. Partial configuration is an error.
- Prefer the configured paired REST `/roll` transport, disable chat creation and
  use its official Foundry engine. The inspected legacy route returns only a
  total and optional numeric results; it cannot establish dice counts, faces,
  active flags or a matching formula. Reject legacy-only configuration before
  HTTP and explain the paired REST migration. Complete paired configuration
  takes precedence. Reject invalid, inconsistent or incomplete responses.
- Once a request is attempted, authentication failures, network failures,
  timeouts, uncertain completion and malformed responses return errors. Never
  retry or silently reroll locally. Preserve delegated caller restrictions.
- Update discovery, schemas, handler and both routers together. Document the
  same grammar for both engines, with unsupported syntax and transport behavior.

## Verification and delivery

Use deterministic RNG fixtures for modifiers, ties, signed/nested expressions,
boundaries and unsupported syntax. Enforce 100% scoped coverage on new parser,
contract and adapter modules, and test changed client/handler/router boundaries.
Compare controlled outcomes with the official Foundry implementation, recording
core, game-system and module versions; independent random totals are not parity
evidence. Built MCP workflows and live integration cover engine selection,
schemas, authorization, request success/failure, uncertain execution and limits.

Run full units, build/workflows, lint, docs, executable/dotenv/packed-consumer
smokes and required live integrations without skips. Record dependency audit and
existing warnings separately. Commit meaningful checkpoints, scan outgoing
secrets, and publish the authorized stacked draft PR and issue update before
starting the next issue. No merge readiness claim while audit/review gates remain.
