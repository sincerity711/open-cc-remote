# open-cc-remote

Remote control plane for local Claude Code sessions. See the
[design spec](docs/superpowers/specs/2026-05-18-open-cc-remote-design.md).

**Status:** Plan 16 (status CLI) complete.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.1
- macOS or Linux

## Quickstart with auth (Plan 2)

In four terminals plus a one-shot pairing step:

```bash
# 0. Install
bun install

# 1. Start fake-IAS (terminal A) — substitute real SAP IAS in production
FAKE_IAS_PORT=7770 bun tools/fake-ias/fake-ias.ts
# → fake-ias listening at http://localhost:7770

# 2. Start the hub (terminal B)
HUB_PORT=7745 \
HUB_DB_PATH=./hub.sqlite \
HUB_JWT_SECRET="$(bun -e 'console.log(crypto.randomBytes(32).toString("base64url"))')" \
HUB_IAS_ISSUER=http://localhost:7770 \
HUB_IAS_CLIENT_ID=cc-remote \
HUB_IAS_CLIENT_SECRET=test-secret \
HUB_IAS_REDIRECT_URI=http://localhost:7745/auth/callback \
HUB_IAS_ALLOWED_SUBJECTS=i060912@sap.com \
HUB_PWA_URL=http://localhost:5173/ \
bun run packages/hub/src/index.ts

# 3. Issue a pairing code (one-shot, terminal C)
HUB_DB_PATH=./hub.sqlite \
bun run packages/hub/src/admin.ts issue-pairing-code i060912@sap.com macbook
# → ABC-DEF

# 4. Pair this machine (one-shot, terminal C)
bun packages/daemon/bin/cc-remote.ts pair \
    --hub ws://localhost:7745 \
    --code ABC-DEF \
    --daemon-id macbook
# → paired as daemon_id=macbook ...

# 5. Run the daemon (terminal C)
bun packages/daemon/bin/cc-remote.ts daemon
# → daemon macbook ready; ... auth=on

# 6. Run a fake Claude Code session (terminal D)
bun tools/fake-claude/fake-claude.ts --session-id demo --cwd "$PWD"

# 7. Run the PWA (terminal E)
VITE_HUB_URL=ws://localhost:7745 bun run --filter=@cc-remote/pwa dev
# → http://localhost:5173/

# 8. Open http://localhost:5173 → click Sign in → fake-IAS auto-redirects
#    back with bearer in fragment → daemon list shows "macbook" with session "demo".
#    Add allow_kill: true to ~/.cc-remote/config.json to enable remote kill_session.
#    Add allow_start: true and allowed_cwd_prefix: ["/your/path"] to enable remote start_session.
```

## Environment variables

| Var | Purpose |
| --- | --- |
| `HUB_PORT` | Hub HTTP/WSS port (default 7745) |
| `HUB_DB_PATH` | Hub SQLite path (default ./hub.sqlite) |
| `HUB_JWT_SECRET` | HS256 secret for daemon JWTs (must be stable across restarts) |
| `HUB_DISABLE_AUTH` | "1" to bypass /ws/* auth (dev/test only) |
| `HUB_PWA_URL` | URL the /auth/callback redirect lands on (default `/`) |
| `HUB_IAS_ISSUER` | IAS OIDC issuer URL |
| `HUB_IAS_CLIENT_ID` | IAS client id |
| `HUB_IAS_CLIENT_SECRET` | IAS client secret |
| `HUB_IAS_REDIRECT_URI` | Callback URL registered with IAS |
| `HUB_IAS_ALLOWED_SUBJECTS` | Comma-separated subject whitelist |
| `CC_REMOTE_STATE_DIR` | Daemon state directory (default `~/.cc-remote`) |
| `CC_REMOTE_SOCKET` | Plugin's daemon socket path |
| `FAKE_IAS_PORT` | fake-IAS listen port |
| `FAKE_IAS_SUB` | fake-IAS subject (default `i060912@sap.com`) |
| `HUB_VAPID_PUBLIC_KEY` | VAPID public key (Web Push) — generate via `bun -e "import('web-push').then(w=>console.log(w.default.generateVAPIDKeys()))"` |
| `HUB_VAPID_PRIVATE_KEY` | VAPID private key |
| `HUB_VAPID_SUBJECT` | mailto: or https:// URL for VAPID subject |
| `VITE_VAPID_PUBLIC_KEY` | VAPID public key for PWA build (same value as `HUB_VAPID_PUBLIC_KEY`) |

## Repo layout

| Package | Purpose |
| --- | --- |
| `packages/proto` | Wire frame TS types and length-prefixed JSON codec |
| `packages/plugin` | Claude Code channel plugin (MCP stdio) |
| `packages/daemon` | Long-running local process; `cc-remote` CLI lives here |
| `packages/hub` | VPS service with IAS OIDC + DPoP daemon auth |
| `packages/pwa` | React/Vite browser client |
| `tools/fake-claude` | Test harness that spawns the plugin |
| `tools/fake-ias` | Test-only OIDC mock |
| `e2e/` | End-to-end tests |

## Tests

```bash
bun test               # all unit + e2e
bun test packages/    # unit only
bun test e2e/         # end-to-end only
bun run typecheck     # 5 packages
```

## Loading the plugin into real Claude Code 2.1.143+

```bash
# Pre-validate the plugin manifest.
claude plugin validate packages/plugin

# Run claude with the plugin loaded. Requires a running daemon
# (cc-remote daemon at ~/.cc-remote/daemon.sock or $CC_REMOTE_SOCKET).
claude --plugin-dir packages/plugin -p "your prompt"
```

## What Plans 1–15 cover

- Plan 1: vertical slice — plugin/daemon/hub/PWA wired up, sessions visible in PWA
- Plan 2: auth — IAS OIDC for PWA, DPoP-bound JWT for daemons, `cc-remote pair` CLI
- Plan 3: real-time conversation streaming — daemon tails Claude Code's session JSONL and streams every line to the PWA's per-session pane
- Plan 4: permission relay — when Claude Code asks to run a tool, an amber banner appears in the PWA with Allow/Deny buttons; the decision flows back to the plugin and is recorded in the daemon's SQLite audit table
- Plan 5: Web Push notifications — when a permission request arrives, all of the user's registered browsers/PWAs receive a push notification via VAPID-signed Web Push, with a service worker showing an OS-level notification
- Plan 6: operational polish — "My devices" settings panel (list/rename/revoke), `cc-remote daemon rotate-token` for periodic credential rotation, hub `/pair/refresh` endpoint
- Plan 7: history scroll-back — scroll up in any SessionPane to load older events from the JSONL file
- Plan 8: launchd / systemd installer — `cc-remote install` writes the right service file for your platform and starts the daemon
- Plan 9: push preferences — Settings panel has a Notifications toggle to opt out of permission-request push
- Plan 10: acceptance suite — automated benchmarks asserting the design spec's quantitative criteria
- Plan 11: daemon-offline push — opt-in notification when a daemon stays offline ≥ 30s; cancelled if the daemon reconnects in time
- Plan 12: remote kill_session — opt-in dangerous action: ✕ button per session terminates the plugin
- Plan 13: remote start_session — opt-in dangerous action: launches a new tmux session running `spawn_command` in a chosen cwd
- Plan 14: task-completed events — daemon detects `assistant` lines with `stop_reason: "end_turn"` and emits a typed `task_completed` event
- Plan 15: idle events — after a task completes, daemon waits `idle_window_ms` (default 30s) for activity; if none, emits `idle`. Cancelled by any new JSONL line. Optional push
- Plan 16: `cc-remote status` CLI — operator visibility for daemon configuration, pairing state, JWT expiry, and recent permission audit entries

## Verified acceptance

- ✅ Permission round-trip P95 < 1s — `e2e/perf-permission.test.ts`
- ✅ 3 concurrent daemons surface within seconds — `e2e/multi-daemon.test.ts`
- ✅ Daemon-offline push debounce honors the 30s window — `packages/hub/tests/router.test.ts`
- ✅ kill_session terminates the plugin and emits session_close — `e2e/kill.test.ts`
- ✅ kill_session is ignored when allow_kill is false (default) — `e2e/kill.test.ts`
- ✅ start_session spawns via tmux when allowed — `e2e/start.test.ts`
- ✅ start_session is ignored when allow_start is false (default) — `e2e/start.test.ts`
- ✅ task_completed emitted on assistant + end_turn — `e2e/completed.test.ts`
- ✅ task_completed NOT emitted on stop_reason: tool_use — `e2e/completed.test.ts`
- ✅ idle event fires after idle_window_ms — `e2e/idle.test.ts`
- ✅ idle event is cancelled by activity within window — `e2e/idle.test.ts`

## Known gaps for Plan 16+

- **Hardware-bound keys** — keystore abstraction layer is in place, but only file-backed Ed25519 ships; macOS Keychain (Security framework) and Linux libsecret bindings are deferred
- **Real Claude Code channel-permissions wire format** — for now `CC_REMOTE_FAKE_PERMISSION` simulates the chain
- **Windows installer** — Plan 8 covers macOS + Linux only

## License

(TBD)
