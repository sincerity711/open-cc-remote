# @cc-remote/e2e-real

Real-component end-to-end test suite for open-cc-remote. Exercises the v1 acceptance checklist against real components: real hub binary in docker compose, real `cc-remote daemon` on host, real `claude` driven through tmux interactive mode, and a scripted PWA-equivalent client.

This complements but does not replace the in-process `e2e/` suite, which remains the merge gate.

## What runs

- `fake-ias` + `hub` — docker compose containers (`docker-compose.yml`, Dockerfiles in `fixtures/`)
- `cc-remote daemon` — spawned per scenario from the local source on the host
- `claude` (real) — driven through tmux + `--mcp-config` + `--dangerously-load-development-channels`
- `pwa-client` — a scripted HTTP+WSS client that drives the IAS login chain and asserts on inbound frames

See `docs/superpowers/specs/2026-05-19-real-e2e-design.md` for the full design.

## Prerequisites

| Tool | Why |
|---|---|
| docker daemon | hub + fake-ias containers |
| `claude` on PATH (Claude Code 2.1.144+) | real Claude Code under tmux |
| `tmux` on PATH | drives the interactive Claude Code session |
| `ANTHROPIC_API_KEY` | real model invocation |

`helpers/preflight.ts` checks all four before any compose starts.

## Run

```bash
bun install
cd e2e-real
bun run test
```

First run builds the docker images (1–3 min). Subsequent runs reuse cached images. Each test file calls `upCompose` in `beforeAll` and `downCompose -v` in `afterAll`, so state is wiped between files.

Manual cleanup if a run is interrupted:

```bash
docker compose -f e2e-real/docker-compose.yml down -v
tmux ls 2>/dev/null | awk -F: '/^ccr-/ {print $1}' | xargs -I{} tmux kill-session -t {} 2>/dev/null
```

## Cost

~$0.20 per full suite at default Haiku (`claude-haiku-4-5`). Permission scenarios add a small premium. The suite emits a final summary line (planned).

## Boundary

What is in scope vs. out of scope is documented in spec §10 (`docs/superpowers/specs/2026-05-19-real-e2e-design.md`). Notably out of scope: real Web Push delivery (file-log stub), real SAP IAS, real TLS, real macOS Keychain, real browser PWA via Playwright, marketplace plugin install.
