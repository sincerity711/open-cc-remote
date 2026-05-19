# CLAUDE.md

Project-local guidance for Claude Code working in this repo.

## What this repo is

`open-cc-remote` — a system that exposes Claude Code sessions running on local machines (via a channel plugin) to a phone/web PWA, through a self-hosted hub. Built incrementally across 16 plans documented under `docs/superpowers/plans/2026-05-18-open-cc-remote-plan-*.md`. Source of truth for the design: `docs/superpowers/specs/2026-05-18-open-cc-remote-design.md`.

## Status

- Plugin MCP rework complete (tag `plan-plugin-mcp-rework`): `docs/superpowers/plans/2026-05-19-plugin-mcp-rework-plan.md` (spec: `docs/superpowers/specs/2026-05-19-plugin-mcp-rework-design.md`)
- 16 milestones tagged: `plan-01-foundation` through `plan-16-status`
- Real-e2e plan (`docs/superpowers/plans/2026-05-19-real-e2e-plan.md`) is paused, unblocked once the rework lands

See `docs/TODO.md` for the unfinished work and the order to resume.

## Important context for new sessions

The plugin in `packages/plugin/` was built against an earlier Claude Code interface (`--channels plugin:cc-remote@local`) that no longer exists in Claude Code 2.1.143. Real Claude Code now uses `--plugin-dir <path>` or `claude plugin install <name>@<marketplace>`, and plugins must be MCP stdio servers declaring `experimental: { 'claude/channel': {}, 'claude/channel/permission': {} }`.

The 164 existing tests work because the `tools/fake-claude/` harness spawns the plugin directly and bypasses Claude Code's actual plugin-loading mechanism. The plugin needs MCP modernization (the paused PMCP plan) before any real Claude Code integration is meaningful.

Wire format details for the channel-permission protocol are at `docs/superpowers/research/channel-permission-protocol.md`.

## How to run things

```bash
bun install
bun test                   # all 164 tests, ~10s
bun run typecheck          # all 5 packages
```

Local manual quickstart and the rest of the runbook are in `README.md`.

## Conventions to follow

- Plans live in `docs/superpowers/plans/YYYY-MM-DD-<name>.md`
- Specs live in `docs/superpowers/specs/YYYY-MM-DD-<name>-design.md`
- Each numbered plan ends with a git tag (`plan-NN-name`) once acceptance passes
- Bun runtime + TypeScript strict + bun:test; PWA uses Vite + React
- Workspace: `packages/*` (production) + `tools/*` (test harnesses) + `e2e/` (in-process e2e) + `e2e-real/` (real-component e2e — paused)
- Each commit message starts with `feat(<pkg>):`, `test(<pkg>):`, `docs:`, `chore:`, or `research:`
- Keep the existing fake-only `e2e/` suite working; it's the merge gate

## Memory system

Per-session memory: `~/.claude/projects/-Users-i060912-SAPDevelop-channel/memory/MEMORY.md` (and the linked entries). Notable entries: project naming, auth design, real-e2e prerequisite, snapshot at 2026-05-18.
