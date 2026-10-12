# ADR-008: npm Trusted Publishing via OIDC

**Status**: Accepted
**Date**: 2026-03-07 (commit cf64b93, PR #113)
**Confidence**: 9/10

## Context

Publishing to npm originally required a long-lived `NODE_AUTH_TOKEN` secret stored in GitHub repository secrets. This token is a security risk:
- Tokens don't expire automatically
- If compromised, can publish malicious packages
- Must be manually rotated

npm introduced [trusted publishing](https://docs.npmjs.com/generating-provenance-statements) via OIDC, which allows GitHub Actions to authenticate without any stored secrets.

## Decision

Replace `NODE_AUTH_TOKEN`-based npm authentication with OIDC trusted publishing:
1. Configure the npm package on npmjs.com to trust GitHub Actions from this repository
2. Use `npm publish` without a token — GitHub Actions OIDC provides authentication
3. Require Node.js ≥ 24 (npm ≥ 11.5.1 required for OIDC publishing support)
4. Remove `--provenance` flag (automatic with OIDC)

## Evidence from Git History

- `cf64b93` `feat(ci): migrate to npm trusted publishing (OIDC) (#113)` — full migration
- `39a41f7` `feat(justfile): add npm-token and publish-dry-run recipes (#111)` — prior token-based tooling
- `6f46e26` `chore: configure npm publishing via CI (#110)` — initial CI publishing setup

Commit message body:
> Replace token-based npm authentication with OIDC trusted publishing.
> Remove NODE_AUTH_TOKEN and --provenance flag (automatic with OIDC)

## Consequences

**Positive:**
- No long-lived secrets in GitHub repository settings
- Provenance attestation is automatic and free
- Reduces secret rotation burden
- Aligned with npm security best practices

**Negative:**
- Requires npm package to be pre-configured on npmjs.com for trusted publishing
- Requires Node.js 24+ in CI (minor constraint)
- One-way migration — if OIDC support is removed from npm, manual rollback needed

## Alternatives Considered

- **Continue with NODE_AUTH_TOKEN**: Rejected — worse security posture, requires manual rotation
- **GitHub Packages**: Rejected — poor discoverability for MCP server users vs npm public registry

## Publishing workflow revision and ownership

Repository maintainers own changes to the publishing workflow pin. The caller uses
`laurigates/.github/.github/workflows/reusable-npm-publish.yml` at
`aad403be1e3d72f68f6536f212ed3a0339263d22`. Review of that exact revision found a
checkout, Bun/Node setup, frozen dependency install, build, and `npm publish`
using OIDC, with no npm token input or inherited secrets. The caller supplies
Node 24. The external file's last change is
`7c3eb911415806b1e99c04861ce9f97fb5f3c743`; both revisions contain the same file.

To update the pin, a maintainer must retrieve the proposed full commit SHA and
compare the reusable workflow with the currently pinned revision. Review its
permissions, action references, checkout source, commands, inputs, secret use,
and package/provenance behavior. Include the SHA and review evidence in a PR in
this repository, and update the checker's `reviewedRevision` with that evidence;
run `bun scripts/check-publish-workflow.js` and `actionlint`.
The policy check parses YAML and rejects unreviewed or mutable publisher references, PR
triggers, broader OIDC grants, and removal of the upstream/main/release guards.
Only the publish job grants `id-token: write`. Forks and PR events cannot publish;
manual publication also requires the upstream main branch and a created release.

The pin freezes the reusable workflow file. Its nested action tags and
`npm@latest` remain external dependencies, and install/build execute repository
code in the publishing job. These are part of the maintainer's revision review;
the pin does not establish immutability of those dependencies.

## Account and release verification

The historical migration and public provenance do not prove current npm account
settings. Before closing a publishing security review, an npm package owner must
inspect **foundryvtt-mcp** Settings → Trusted publishing and record the configured
GitHub owner/repository, caller workflow filename, optional environment, and tag
restrictions. The expected upstream binding is `laurigates/foundryvtt-mcp` and
`release-please.yml`; do not substitute the reusable workflow repository. Review
all publisher entries and publishing access, including any traditional token
fallback. This fork intentionally cannot publish that upstream package.

An equivalent local fixture can verify workflow policy, build, packed package
name/version/files and tarball integrity without publishing. It cannot mint a
GitHub OIDC identity or produce a real npm provenance attestation. Record this
gap explicitly. For a controlled authorized release, compare the registry package
name/version and tarball integrity with the expected artifact, run
`npm audit signatures`, and verify the attestation subject digest, source commit,
caller workflow and GitHub run against the reviewed release. Keep the security
issue open until account binding and release provenance evidence are available.

References: [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/)
and [npm provenance verification](https://docs.npmjs.com/generating-provenance-statements/).
