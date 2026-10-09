# Issue #1: stable identifiers and structured reads

Status: planned; validation results must be recorded before completion.

## Contract and scope

Keep existing tool names and inputs compatible. Add a versioned typed envelope
to actor/item reads via MCP `structuredContent` and advertised `outputSchema`,
retaining useful text summaries. Each record identifies its world document by
ID, document type and name. Include a UUID only when its scope is established
by the source; do not manufacture UUIDs from an ambiguous REST response.

Inventory current item-detail support before implementation. If no item-detail
operation exists, add a narrowly scoped world-item read with the same backend
view and document its addition. Embedded/compendium reads and expanded access
are outside this issue. Keep item system normalization/filter behavior for #13.

Preserve zero, false, and empty values distinctly from missing data. Validate
identifiers before backend lookups; document invalid, missing, removed, and
unavailable-record errors. Validate returned identity and output shape.

## Implementation sequence

1. Define the read envelope, output schemas and public TypeScript types.
2. Add failing handler/client tests for the contract and negative cases.
3. Implement actor/item mappings, text and structured results, and detail reads.
4. Update tool descriptions, compatibility notes and search-to-detail examples.
5. Exercise the MCP protocol workflow and live Foundry read workflow.
6. Run required checks, commit milestones, update #1 and publish its PR.

Implementation delegate: GPT-6.1 Sol with high reasoning effort. The primary
agent reviews the changes and validates the completed contract.

## Acceptance-case matrix

Every row requires an asserted positive or negative outcome. Track executed,
failed, unavailable and skipped cases separately; unavailable/skipped live
checks are never passes. Coverage claims apply to this enumerated contract,
not to all possible behaviors of Foundry or the repository.

| Surface | Positive cases | Negative/boundary cases |
| --- | --- | --- |
| Actor search and details | Duplicate names resolve by ID; zero HP/AC/level; actual optional fields; empty search; Socket.IO and REST mappings | Invalid/nonstring/empty/path-like IDs; missing/removed actors; unavailable backend; response ID mismatch; malformed response |
| Item search and supported details | Duplicate names resolve by ID; zero price/quantity/weight; false booleans; empty strings; Socket.IO and REST mappings | Invalid IDs; missing/removed items; unavailable backend; response ID mismatch; malformed response |
| MCP result contract | Published schemas validate every result; text/structured IDs and displayed values agree; old text consumers still work | Invalid structured shapes fail validation; unverified/cross-scope UUIDs omitted or rejected |
| Protocol workflow | `tools/list` advertises schemas; `tools/call` search then detail selects both same-name records | Protocol calls reject invalid IDs and missing/removed documents; cleanup completes |
| Live Foundry workflow | Real search-to-detail identity verified; core/system/module versions recorded | Invalid and removed document cases; no skipped cases counted as passes |
| Required checks | Build; full unit suite; lint; docs check; startup smoke; package smoke | Baseline failures documented separately from regressions |

## Initial evidence and preconditions

- Local baseline: `23a28b2ee8031997e37de855493ecb73f5147a92` (v1.5.3).
- Fork: `sodejm/foundryvtt-mcp`, default branch `main`.
- Upstream actor handler rechecked through GitHub: IDs still omitted and
  truthiness fallbacks still present.
- No live fixture, license or test credentials are configured in this workspace.
  Live test details have been requested; completion remains gated on their use.
- Shell networking requires the execution tool's network permission; an npm
  registry probe succeeds when that permission is included.
