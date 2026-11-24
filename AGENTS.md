# Agent instructions

This repository implements an MCP server for FoundryVTT. It uses Node.js 22.12+
and Bun for package management. Keep the STDIO protocol clean: never write logs
or diagnostics to standard output from the server process.

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
