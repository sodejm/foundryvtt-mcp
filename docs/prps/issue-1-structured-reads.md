# Issue #1: stable identifiers and structured reads

Status: implementation and local validation complete; live Foundry validation
is unavailable. Issue #1 remains open and its PR must remain draft until the
required live checks pass. Do not select #2 before resolving this gate.

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

## Implemented behavior

- Searches return `{schemaVersion: 1, documentType, records, total, page, limit}`;
  details return `{schemaVersion: 1, documentType, record}`.
- All four tools advertise output schemas and return `structuredContent` with
  an explicit field allowlist alongside text. IDs appear in both outputs.
- Added `get_item_details` / `FoundryClient.getItem` scoped to world items;
  both routers expose the same validated handlers.
- Detail IDs retain the existing 16-character alphanumeric contract. Invalid
  inputs return `InvalidParams` before I/O; unavailable, removed, malformed or
  mismatched records return `InternalError`.
- Cached world collections establish UUID scope. REST UUIDs are omitted.
  Missing values stay absent, and zero/false/empty values survive mapping.
- Existing freshness, pagination and game-system filter limits remain subjects
  of their subsequent issues. Retained snapshots may remain readable offline.

## Recorded local validation

Dependency installation used the canonical frozen `bun.lock` (Bun 1.4.2,
Node 24.19.0, Vitest and its coverage provider 4.1.9).

| Check | Result |
| --- | --- |
| `npm run build` | Passed |
| Full unit suite via `npm run test:reads:coverage` | 646/646 passed in 31 suites; 126 added cases |
| Scoped coverage: `read-contract.ts`, `actors.ts`, `items.ts` | 100% statements (75/75), branches (87/87), functions (14/14), lines (75/75); thresholds enforced |
| `npm run test:workflow` | 22/22 passed; built CLI, SDK stdio, local HTTP fixture, no production-function mocks |
| Strict TypeScript check of new workflow/live test files | Passed |
| `npm run lint` | Passed; same 11 baseline warnings |
| `npm run docs:check` | Passed; same 3 baseline warnings |
| Startup, dotenv and pack/install smoke | Passed |
| Required redacted Gitleaks scans and commit hooks | Passed |
| Live Foundry integration | Unavailable; no license, credentials, bootstrapped world, or recorded live versions |

The case matrix above is implemented by handler/client contract tests, primary
and registry-router tests, and the 22-case built CLI workflow. Positive and
negative local cases pass. The live row remains unexecuted; no claim of 100%
overall acceptance coverage or completion is made. Code coverage above applies
only to the named contract/handler files, not the whole repository.

The prepared live test requires duplicate actor/item fixtures and reports core,
system and module versions. Additional live removed-document and REST module
checks remain required by the issue. Skipped or unavailable tests cannot close
this gap. Preserve this report and branch for continuation once a fixture is
available.
