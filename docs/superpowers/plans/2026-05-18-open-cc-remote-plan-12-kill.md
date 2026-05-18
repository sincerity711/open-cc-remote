# open-cc-remote — Plan 12: Remote kill_session

> **For agentic workers:** Compressed. Full code in dispatch prompts.

**Goal:** PWA can terminate a session remotely. The plugin receives a `terminate` signal from daemon and shuts down (which causes Claude Code's session to end). Gated by daemon config (`allow_kill: false` by default).

**Architecture:**
- New PWA→hub frame: `kill_session { daemon_id, session_id }`
- Hub→daemon frame: `kill_session { session_id }`
- Daemon-plugin signal: existing `bye` flow is plugin→daemon. We need daemon→plugin "interrupt": close the plugin's Unix socket from daemon side. Plugin's existing `sock.on("close")` handler triggers `goodbye(0)`, which exits the plugin process. Claude Code reacts to plugin death (stops the session).
- Daemon checks `allow_kill` before honoring; otherwise responds with no-op (logged).

**Out of scope:** start_session (spawning tmux). `allowed_cwd_prefix` config — keeping daemon-side check binary for now.

---

## Tasks

### T1 — Proto: kill_session frames

Add `PwaToHubKillSession`, `HubToDaemonKillSession`. Extend unions. No-op handlers in router/ws.

### T2 — Daemon: handle kill_session

Modify `packages/daemon/src/index.ts`:
- Read new config flag `allow_kill: boolean` (default false) from config.json
- On hub `kill_session`: if `allow_kill && session exists in liveSessions`, find the originating plugin client (we already track via `clientToSession` map) and close its socket. Otherwise log and ignore.

Modify `packages/daemon/src/config.ts` to support the flag.

### T3 — Hub: route kill_session

`router.onPwaCommand` handles the frame. `routes.ts` PWA dispatch already forwards `permission_reply` and `request_history`; extend to `kill_session`.

### T4 — PWA: kill button per session

In `App.tsx` session row, add a small ✕ button next to each session that, when clicked, prompts `confirm()` and sends `kill_session`. Add `killSession` callback to `useHub`.

### T5 — e2e test

Spawn full stack with `allow_kill: true` in config. fake-claude registers. PWA sends kill_session. Verify session_close arrives + fake-claude exits.

### T6 — README + tag

Tag `plan-12-kill-session`.
