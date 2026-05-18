# open-cc-remote — Plan 13: Remote start_session

> **For agentic workers:** Compressed. Full code in dispatch prompts.

**Goal:** PWA can launch a new Claude Code session on a daemon's machine. Spawned via `tmux new-session -d -s <name> '<spawn_command>'`. Gated by daemon config (`allow_start: false` default + `allowed_cwd_prefix` array).

**Architecture:**
- Daemon config new fields: `allow_start: bool`, `allowed_cwd_prefix: string[]`, `spawn_command: string` (defaults to `claude --channels plugin:cc-remote@local`).
- New PWA→hub frame: `start_session { daemon_id, cwd, name? }`
- Hub→daemon: `start_session { cwd, name? }`
- Daemon validates: allow_start, cwd starts with one of allowed_cwd_prefix, then spawns tmux + spawn_command.

The actual Claude Code session launches and the new plugin connects to daemon via Unix socket as usual; no other wiring needed.

For tests: configure `spawn_command` as `sh -c 'sleep 60'` (a simple long-running process) so we exercise the spawn machinery without needing real Claude Code.

**Out of scope:** Stream/show the spawn output (would need stdout proxying); progress reporting on PWA.

---

## Tasks

### T1 — Proto: start_session frame

Add `PwaToHubStartSession` (daemon_id, cwd, name?) and `HubToDaemonStartSession` (cwd, name?). Extend unions.

### T2 — Daemon: config + handler

Add `allow_start: boolean` (default false), `allowed_cwd_prefix: string[]` (default []), `spawn_command: string` (default `claude --channels plugin:cc-remote@local`) to config.

In `onFrame` (hub-client), handle `start_session`: validate allow_start, cwd within allowed prefixes, then `spawn("tmux", ["new-session", "-d", "-s", <name>, "-c", <cwd>, spawn_command])`. Tests for the validation logic.

### T3 — Hub: route start_session

Already trivial via onPwaCommand pattern.

### T4 — PWA: "Start session" UI

Add a "Start session" form in App header per daemon: input for cwd, button to submit.

### T5 — e2e test

Spawn full stack with `allow_start: true`, `spawn_command: "sh -c 'sleep 5'"`. PWA sends start_session. Verify tmux session was created (using `tmux ls` or by connecting to the session).

Actually, simpler: verify daemon spawned the child process. We can intercept by setting `spawn_command: "echo started > /tmp/file"` and asserting the file appears.

### T6 — README + tag

Tag `plan-13-start-session`.
