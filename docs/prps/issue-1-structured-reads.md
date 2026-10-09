# Issue #1: stable identifiers and structured reads

Status: implementation and required issue #1 validation complete. The actual
MCP stdio workflow passes all 13 live cases against the disposable `test1world`.
PR #23 is prepared for review; merge and issue closure remain separate actions.

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
- The user licensed the local instance and created the disposable `test1world`,
  authorizing all feature testing on this server. Its endpoint is
  `http://127.0.0.1:30001`.
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
- Live validation required preserving explicitly configured blank passwords at
  startup and supplying the matching origin on Foundry's login request. These
  are narrow compatibility fixes for the existing Socket.IO authentication path.
- Item mapping preserves numeric dnd5e `system.weight.value`, including zero,
  alongside the existing numeric `system.weight` representation.

## Recorded local validation

Dependency installation used the canonical frozen `bun.lock` (Bun 1.4.2,
Node 26.11.0 for the MCP tests, Vitest and its coverage provider 4.1.9).
Foundry runs with its separate Node 24.13.1 runtime.

| Check | Result |
| --- | --- |
| `npm run build` | Passed |
| Full unit suite via `npm run test:reads:coverage` | 654/654 passed in 31 suites |
| Scoped coverage: `read-contract.ts`, `actors.ts`, `items.ts` | 100% statements (75/75), branches (87/87), functions (14/14), lines (75/75); thresholds enforced |
| `npm run test:workflow` | 22/22 passed; built CLI, SDK stdio, local HTTP fixture, no production-function mocks |
| Strict TypeScript check of new workflow/live test files | Passed |
| `npm run lint` | Passed; same 11 baseline warnings |
| `npm run docs:check` | Passed; same 3 baseline warnings |
| Startup, dotenv and pack/install smoke | Passed |
| Required redacted Gitleaks scans and commit hooks | Passed |
| Issue #1 live MCP integration | 13/13 passed; no skipped cases |
| Broader existing integration suite | 48 passed, 2 failed, 6 skipped; see limits below |

The case matrix above is implemented by handler/client contract tests, primary
and registry-router tests, and the 22-case built CLI workflow. Positive and
negative local cases pass. Code coverage above applies only to the named
contract/handler files, not the whole repository.

## Recorded live validation and limits

The live test starts `src/index.ts` through the MCP SDK stdio transport and
validates results against the schemas returned by `tools/list`. It verifies
both duplicate actors and both duplicate items by their returned IDs, details,
UUIDs and text/structured parity. It checks zero, false and empty values;
invalid IDs; absent IDs; and previously deleted actor/item IDs. Missing required
fixtures fail the test instead of becoming skipped passes.

Recorded environment: Foundry core **14.369**, world **test1world**, game system
**dnd5e 6.0.6**, enabled modules **[]**, Socket.IO transport, Gamemaster user
with an explicitly configured blank test password. REST mappings pass unit and
local HTTP workflow tests; no live REST module is installed, so this report
does not claim live REST-module validation.

The broader existing integration run is not a full pass: `refreshWorldData`
times out on Foundry 14 in the world-data refresh case and after combat
creation. The existing combat cleanup still runs. Those refresh failures
belong to the snapshot/freshness work in #3 and are not hidden by the passing
read cases. Two combat cases lacked an active combat fixture and four actor
mutation cases lacked a currency-bearing actor fixture; these six skips count
as unexecuted cases. Further feature testing must supply those fixtures and
verify write results by reading them back.

Local validation receipts and full logs are retained outside Git in
`/private/tmp/foundry-issue-1-validation`. No fixture credentials or private
runtime data are committed.
