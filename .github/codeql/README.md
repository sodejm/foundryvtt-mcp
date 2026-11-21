# CodeQL policies

The security workflow runs Security Extended for JavaScript/TypeScript, Python,
and GitHub Actions. JavaScript analysis also runs
`javascript/queries/RequireDelegatedDispatchGuard.ql`. Query fixtures run before
analysis and are excluded from the production database.

## Delegated dispatch guard

The custom query covers `src/tools/router.ts` and `src/tools/new-router.ts`:
registry dispatch, legacy handler dispatch, resource dispatch, and the shared
`routeLegacyTool` helper. Authorization must use the original requested tool
name or URI and the same Foundry client, and must succeed before dispatch on
every control-flow path. A guard in an unrelated callback, a swallowed exception,
a different argument, or a reassigned argument does not satisfy the policy.
Simple variable aliases and renamed imports are supported.

The private legacy helper may inherit authorization only when every direct call
is guarded and its arguments preserve the requested identifier and client.
Exporting the helper or passing its function value elsewhere disables inherited
authorization. Diagnostic-only handlers still require authorization against the
route's Foundry client.

This query models the repository's current named imports, registry context
object literals, and switch-based legacy dispatch. Registry contexts with spreads
or property assignments are rejected conservatively. Additional dispatch styles,
indirect calls, or changes to router paths and signatures require updating the
query and fixtures. Catch/finally handling is conservative: a reachable finally
continuation may need a guard outside the try statement to avoid a finding.
The query checks placement and value identity; authorization implementation and
runtime policy remain covered by the application tests.

## Regression tests

Run from the repository root with the CodeQL CLI and pack registry access:

```sh
codeql pack install .github/codeql/javascript
codeql test run .github/codeql/javascript/tests
```

The extraction-only fixtures use local inert authorization, registry, and handler
stubs; they do not connect to Foundry or execute dispatches. Both router layouts
have correctly guarded cases and regressions for missing guards, identifier/client
mismatches, branch bypasses, mutation, exception swallowing, and helper forwarding.
The expected output records alert locations, so one failing helper case can report
both the unguarded call and the helper's handler dispatch. Review changes to
`.expected` against the fixture's intended behavior; do not regenerate expectations
as a substitute for checking them.
