# cc-remote (channel)

Remote-control real Claude Code TUI from a PWA. Architecture:
**CC TUI ↔ daemon (host) ↔ hub (docker) ↔ PWA (browser)**.

## Quick orientation

| Doc | When to read |
|---|---|
| [`docs/operations/local-debug-environment.md`](docs/operations/local-debug-environment.md) | **Read first** before debugging the demo. Covers `tools/demo-channel.sh`, the AskUserQuestion remote-relay hook, the hub-Docker-image-drift footgun, and a step-by-step checklist for "PWA isn't showing the picker". |
| [`docs/operations/push-deployment.md`](docs/operations/push-deployment.md) | Web-push (VAPID) config. |
| [`docs/operations/reverse-proxy.md`](docs/operations/reverse-proxy.md) | Reverse-proxy bypass for daemon-auth paths + `HUB_TRUSTED_PROXIES` + rate-limit env vars. |
| [`docs/operations/sap-cf-deploy.md`](docs/operations/sap-cf-deploy.md) | SAP Cloud Foundry deploy. |
| [`docs/design/`](docs/design/) | UI design references (cards, light/dark mocks). |
| [`docs/TODO.md`](docs/TODO.md) | Non-UI backlog. |

## Layout

- `packages/daemon/` — host process; tails CC's jsonl, owns the local hook
  socket at `/tmp/cc-remote-demo/daemon.sock`, talks to hub over WSS.
- `packages/hub/` — docker container; frame router + IAS bridge. **Note**:
  built into a Docker image, so source changes need an image rebuild — see
  the local-debug doc, §5.
- `packages/pwa/` — vite + React app.
- `packages/plugin/` — `cc-remote` MCP plugin loaded by CC.
- `packages/proto/` — wire-frame types shared across daemon/hub/PWA.
- `.claude/hooks/ask-user-relay.ts` — CC PreToolUse hook that proxies
  AskUserQuestion to the PWA. **Not git-tracked yet** — see local-debug
  doc, §3.
- `e2e-real/` — Playwright + docker-compose harness. Real CC against real
  hub + fake-IAS.
- `tools/demo-channel.sh` — bring up local demo (hub container, daemon,
  PWA, tmux'd CC) for hands-on testing.

## Common commands

```bash
# bring up local demo
./tools/demo-channel.sh up

# attach to the real CC TUI
tmux attach -t demo-claude

# unit tests
bun test

# real-environment e2e
cd e2e-real && bun playwright test
```
