# open-cc-remote — Plan 11: Daemon offline push notification

> **For agentic workers:** Compressed. Full code in dispatch prompts.

**Goal:** When a daemon stays offline for ≥ 30s (spec §6.5 default), push a notification to all of the user's devices. Adds an `offline` toggle to push preferences (default off — opt-in, since brief disconnects are common).

**Architecture:**
- Hub Router schedules a `setTimeout` for `OFFLINE_PUSH_DELAY_MS` (default 30000) on `onDaemonDisconnect`
- If daemon reconnects (`onDaemonFrame` "hello" with same daemon_id) before the timer fires, cancel it
- Else fire push to subscribers whose preferences allow it (default `offline: false` → opt-in)
- Service worker handles `kind: "offline"` payload

---

## Tasks

### T1 — Hub debounced offline push

Modify `Router`:
- Track per-daemon offline timers: `Map<daemon_id, NodeJS.Timeout>`
- On disconnect: schedule timer (30s default, configurable via `OFFLINE_PUSH_DELAY_MS` env)
- On hello: clear any existing timer
- When timer fires: dispatch push to subscriptions where `prefs.offline === true`

Push payload: `{ kind: "offline", daemon_id, hostname, since_ms }`.

Tests:
- timer scheduled on disconnect, cleared on reconnect (use jest fake timers or short test delay; we'll use a short OFFLINE_PUSH_DELAY)
- timer fires → push.sendTo called

### T2 — Preferences default + handler

Modify `repos/push-subs.ts` DEFAULT_PREFS to include `offline: false`. Modify the push helper filter site (in T1) to check `prefs.offline === true` (not `!== false`) — opt-in.

Modify PWA Settings to expose the toggle.

Modify service worker to render an offline notification.

### T3 — README + tag

Document, tag `plan-11-offline-push`.
