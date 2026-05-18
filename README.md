# open-cc-remote

Remote control plane for local Claude Code sessions. See the
[design spec](docs/superpowers/specs/2026-05-18-open-cc-remote-design.md).

**Status:** Plan 1 (foundation + vertical slice) complete. Auth, transcript streaming,
permission relay, Web Push, and install scripts arrive in Plans 2–6.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.1
- macOS or Linux

## Quickstart (manual)

In four terminals:

```bash
# 1. Install workspace deps
bun install

# 2. Run the hub (terminal A)
bun run packages/hub/src/index.ts
# → hub listening on http://localhost:7745

# 3. Configure & run a daemon (terminal B)
mkdir -p ~/.cc-remote
echo '{"daemon_id":"local","hub_url":"ws://localhost:7745"}' > ~/.cc-remote/config.json
bun run packages/daemon/src/index.ts
# → daemon local ready; ...

# 4. Run a fake Claude Code session (terminal C)
bun tools/fake-claude/fake-claude.ts --session-id demo --cwd "$PWD"

# 5. Open the PWA (terminal D)
bun run --filter=@cc-remote/pwa dev
# → open http://localhost:5173
```

You should see one daemon ("local") with one session ("demo"). Killing the
fake-claude process removes the row.

## Repo layout

| Package | Purpose |
| --- | --- |
| `packages/proto` | Wire frame TS types and length-prefixed JSON codec |
| `packages/plugin` | Claude Code channel plugin (MCP stdio) |
| `packages/daemon` | Long-running local process; aggregates plugins, talks to hub |
| `packages/hub` | VPS service: routes daemon ↔ PWA |
| `packages/pwa` | React/Vite browser client |
| `tools/fake-claude` | Test harness that spawns the plugin |
| `e2e/` | End-to-end tests |

## Tests

```bash
bun test               # all unit + e2e tests
bun test packages/    # unit tests only
bun test e2e/         # end-to-end only
```

## What Plan 1 does NOT cover

- Authentication (no IAS, no DPoP — anyone can connect to the hub)
- Real Claude Code conversation streaming (sessions show up but transcript is empty)
- Permission relay
- Persistence (no SQLite yet)
- Web Push
- File uploads
- `cc-remote install` / launchd / systemd units

These come in Plans 2–6.
