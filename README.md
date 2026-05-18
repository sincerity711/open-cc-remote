# open-cc-remote

Remote control plane for local Claude Code sessions. See the
[design spec](docs/superpowers/specs/2026-05-18-open-cc-remote-design.md).

**Status:** Plan 7 (history scroll-back) complete.

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

## What Plans 1–7 cover

- Plan 1: vertical slice — plugin/daemon/hub/PWA wired up, sessions visible in PWA
- Plan 2: auth — IAS OIDC for PWA, DPoP-bound JWT for daemons, `cc-remote pair` CLI
- Plan 3: real-time conversation streaming — daemon tails Claude Code's session JSONL and streams every line to the PWA's per-session pane
- Plan 4: permission relay — when Claude Code asks to run a tool, an amber banner appears in the PWA with Allow/Deny buttons; the decision flows back to the plugin and is recorded in the daemon's SQLite audit table
- Plan 5: Web Push notifications — when a permission request arrives, all of the user's registered browsers/PWAs receive a push notification via VAPID-signed Web Push, with a service worker showing an OS-level notification
- Plan 6: operational polish — "My devices" settings panel (list/rename/revoke), `cc-remote daemon rotate-token` for periodic credential rotation, hub `/pair/refresh` endpoint
- Plan 7: history scroll-back — scroll up in any SessionPane to load older events from the JSONL file; daemon reads forward, returns last N before the requested offset

Click any session row in the PWA to open its live event log on the right.
Scroll up to load older events from disk.
When a permission prompt arrives it shows at the top of the PWA across all sessions.
With VAPID keys configured, your phone or laptop's PWA gets a push notification too — even when the tab isn't focused.
The Settings button in the header lets you manage all your registered devices.

## Known gaps for Plan 8+

- **Acceptance suite** — P95 < 1s permission round-trip; 30s offline detection; 3+ daemons concurrently
- **Hardware-bound keys** — keystore abstraction layer is in place, but only file-backed Ed25519 ships; macOS Keychain (Security framework) and Linux libsecret bindings are deferred
- **Install scripts** — `cc-remote install` for launchd / systemd user units
- **Real Claude Code channel-permissions wire format** — for now `CC_REMOTE_FAKE_PERMISSION` simulates the chain; integrating with Claude Code's actual `--channels` permission protocol is open work
- **Push preferences UI** — per-event toggles (idle, completed, daemon_offline); only `permission_request` triggers push today

## License

(TBD)
