# Agent instructions

This repository implements an MCP server for FoundryVTT. It uses Node.js 22.12+
and Bun for package management. Keep the STDIO protocol clean: never write logs
or diagnostics to standard output from the server process.

## AAIF-compatible agent guidance

This root file follows the open `AGENTS.md` convention stewarded by the
[Agentic AI Foundation (AAIF)](https://aaif.io/projects/agents-md). It is the
repository-neutral entry point for coding agents, so keep it concise,
actionable, and applicable regardless of the agent a contributor uses.

- Check for a nearer `AGENTS.md` before editing a subdirectory; a nearer file
  supplements this root guidance for that area. There are no nested
  `AGENTS.md` files today.
- Keep setup, validation, security, transport, and workflow instructions here
  aligned with `package.json`, CI, and the binding details in `.claude/rules/`.
  When any of those sources change, update this file and the relevant
  Claude-specific context in `CLAUDE.md` in the same change.
- Put tool-specific context in its companion file rather than duplicating it:
  `CLAUDE.md` contains Claude architecture context; this file remains the
  shared operational contract.

## Working safely

- Install the lockfile exactly with `bun install --frozen-lockfile`.
- Run `bun run lint`, `bun run build`, and `bun run test` before proposing a
  change. Run `bun run smoke:dotenv` and `bun run test:workflow` when changing
  packaging, environment loading, or workflow behavior.
- Read operations must work with both the Socket.IO and REST transports. Write
  operations must remain disabled unless `FOUNDRY_WRITE_ENABLED=true`.
- Keep environment loading in the side-effect entrypoint described in
  `.claude/rules/esm-entrypoint-env-loading.md`; do not move it into modules
  that are imported before configuration is read.
- Never commit Foundry credentials, API keys, or populated `.env` files.

`CLAUDE.md` adds architecture context for Claude-specific workflows. The
transport, test, and release rules under `.claude/rules/` are binding details
for all coding agents.
