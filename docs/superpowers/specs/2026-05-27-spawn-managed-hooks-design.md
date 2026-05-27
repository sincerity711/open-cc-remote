# Daemon-Managed Hook Settings (AskUserQuestion relay)

Date: 2026-05-27
Status: Draft (post-brainstorming)

## 1. Problem

The AskUserQuestion remote relay (TODO §"AskUserQuestion remote relay", shipped 2026-05-27) is enabled by two static files in this repo:

- `.claude/settings.json` — registers a `PreToolUse` hook with matcher `AskUserQuestion`.
- `.claude/hooks/ask-user-relay.ts` — the hook implementation that proxies questions through the daemon → hub → PWA.

CC discovers `.claude/settings.json` by walking up from `cwd`. That means **every** Claude Code session whose `cwd` is anywhere under `/Users/.../channel/` loads the hook, including the developer's own local CC sessions when they're working on this repo. In those sessions there is no PWA waiting, so AskUserQuestion calls block for the full 5-min `expires_at` and finally return a synthesized error ("[cc-remote AskUserQuestion relay] No answer received before expiry…"), corrupting the UX of the local Claude Code.

The intent is the opposite: the relay should **only** intercept AskUserQuestion in the CC processes that the daemon spawned (via `start_session` → `tmux new-session … <spawn_command>`). Other CC processes — including the developer's own — must be unaffected.

## 2. Goals

- AskUserQuestion relay activates **only** for CC processes spawned by the daemon's `start_session` flow.
- Local CC sessions in this repo (`cwd ∈ channel/…`) get native AskUserQuestion behavior with no interception, regardless of how they were started.
- Hook source code lives in the daemon and ships with the daemon, not as untracked files in the repo.
- Per-session isolation: each daemon-spawned CC has its own settings + hook artifacts, cleaned up on session end.

## 3. Non-Goals

- Generalizing this into a "hook-injection framework". Only the AskUserQuestion relay needs it today; future hooks can reuse the same machinery if/when added.
- Hot-reloading the hook script across an already-running CC session. Spawned CC keeps the hook it was launched with; rebuild a session to pick up changes.
- Allowing the user's `spawn_command` in `cfg` to bring its own competing hook for AskUserQuestion. If both are present, last-wins (CC's `--settings` is additive; behavior undefined).
- Migrating any other CC integration (MCP config, `--mcp-config`) to the same pattern. MCP config is already daemon-owned via `<state_dir>/mcp-config.json`; this spec touches only hooks.

## 4. Architecture

```
┌─────────── Daemon ───────────────────────────────────────────────────────┐
│                                                                          │
│  packages/daemon/assets/ask-user-relay.ts   ← hook source, in repo,     │
│                                               imported as text by daemon │
│                                                                          │
│  start_session(cwd, request_id):                                         │
│    spawnDir = <state_dir>/sessions/<request_id>/                         │
│    mkdir -p spawnDir                                                     │
│    write spawnDir/ask-user-relay.ts  ← copy of bundled script,          │
│      chmod +x                          owned by daemon                   │
│    write spawnDir/settings.json with:                                    │
│      { hooks: { PreToolUse: [{                                           │
│          matcher: "AskUserQuestion",                                     │
│          hooks: [{ type: "command", command: <abs path>, timeout: 350000 │
│      }]}]}}                                                              │
│                                                                          │
│    tmux new-session -d -s <name> -c <cwd> \                              │
│      <cfg.spawn_command> --settings <abs settings.json>                  │
│                                                                          │
│  on session_close: rm -rf spawnDir                                       │
│  on daemon start:  GC <state_dir>/sessions/* older than 24h              │
└──────────────────────────────────────────────────────────────────────────┘
```

CC's `--settings <file>` flag is **additive** to its discovery chain (verified via `claude --help`). The user's project-level `.claude/settings.json` (if any) still loads; daemon's per-session settings layer on top. There is no need to disable any source via `--setting-sources`.

`cwd` for the spawned CC is unchanged — still the user's chosen working directory. Only the settings file the daemon contributes lives in the per-session `<state_dir>/sessions/<request_id>/`.

## 5. Components

### 5.1 Hook source as a daemon asset

- Move `.claude/hooks/ask-user-relay.ts` → `packages/daemon/assets/ask-user-relay.ts`. Same Bun-runnable script, no logic change.
- `packages/daemon/src/spawn-hooks.ts`: exports `getHookScript(): string` which reads (or `import`s as text) the asset at runtime, plus `prepareSpawnDir({state_dir, request_id}): { settingsPath, dir }` that writes the script + settings.json into the per-session dir and returns absolute paths.

### 5.2 Wiring into `start_session`

- `packages/daemon/src/index.ts` `start_session` handler: call `prepareSpawnDir` immediately after `precheckStartSession` succeeds; capture `settingsPath`.
- Append `--settings <settingsPath>` to the tmux command. (Implementation: pass as additional argv after `cfg.spawn_command!` in the `tmux new-session … <cmd>` argv.)

### 5.3 Cleanup

- `sessions.onRemove`: rm `<state_dir>/sessions/<request_id>/` if it exists. Best-effort; log on failure but don't throw.
- Daemon startup: scan `<state_dir>/sessions/`, `rm -rf` any subdirs whose mtime is > 24h. One-shot; no scheduled task.

### 5.4 Repo cleanup

- Delete `.claude/settings.json` and `.claude/hooks/ask-user-relay.ts` from the working tree (both currently untracked per CLAUDE.md §"Layout" → "Not git-tracked yet").
- Add `.claude/` to `.gitignore` if not already (verify; may already be).
- CLAUDE.md "Layout" entry for `.claude/hooks/ask-user-relay.ts` → update to point at `packages/daemon/assets/ask-user-relay.ts` and explain the runtime-injection model.

## 6. Data Flow

Single change vs the existing AskUserQuestion relay flow (TODO §"AskUserQuestion remote relay" → "Implementation"):

- **Hook script location**: was `$CLAUDE_PROJECT_DIR/.claude/hooks/ask-user-relay.ts`; becomes `<state_dir>/sessions/<request_id>/ask-user-relay.ts`.
- **Hook activation predicate**: was "any CC whose cwd resolves to channel/"; becomes "any CC launched with `--settings <state_dir>/sessions/*/settings.json`".

Everything from "hook reads stdin, opens daemon socket, sends `ask_user_question_request`" onward is unchanged. The daemon socket protocol is untouched. Proto frames unchanged. PWA flow unchanged.

## 7. Error Handling

- `prepareSpawnDir` failure (mkdir/write): treat as a `start_session_rejected` with `reason="hook_setup_failed"`. New reason added to the proto union; PWA's `startSessionErrors` already renders unknown reasons via the message field, so PWA-side change is just the proto type.
- Cleanup failure on `session_close`: log `warn` with `error=…`; don't propagate. The 24h GC will pick it up later.
- Stale spawn dir on daemon restart: GC sweep handles it. If the spawn dir is missing when CC tries to read `--settings <path>`, CC ignores invalid settings silently (per `--print` mode docs; same applies to interactive). Acceptable: fallback to no hook = native AskUserQuestion = local-fallback behavior, which is safer than crashing.
- Hook script disk write succeeds but chmod fails: log error, abort `start_session` with `reason="hook_setup_failed"`. We cannot run a non-executable hook on the user's behalf.

## 8. Testing

- Unit: `prepareSpawnDir` writes both files with correct content + chmod; idempotent on re-call with same `request_id` (overwrites).
- Unit: the GC sweep removes only dirs older than 24h, leaves fresh ones.
- Unit: `start_session_rejected` with `reason="hook_setup_failed"` round-trips through proto codec.
- Integration: extend e2e-real scenario `23-ask-user-question.test.ts` — assert that the spawned CC's `tmux capture-pane` does NOT show the native AskUserQuestion UI (i.e., the hook intercepted), and that PWA receives the `ask_user_question_request`. Add a sibling assertion that running CC manually (without going through `start_session`) in a temporary cwd inside `e2e-real/` does NOT trigger the hook.
- Manual: `claude` in the `channel/` repo must NOT show the relay error message. Verifies the original bug is fixed.

## 9. Migration / Rollout

Single PR. No proto wire-format change beyond the new `start_session_rejected` reason (additive, backward compatible). Steps:

1. Add `packages/daemon/assets/ask-user-relay.ts` (copy of current `.claude/hooks/ask-user-relay.ts`).
2. Add `packages/daemon/src/spawn-hooks.ts` with `prepareSpawnDir` + `getHookScript`.
3. Wire into `start_session` and `sessions.onRemove`; add startup GC.
4. Delete `.claude/settings.json` and `.claude/hooks/ask-user-relay.ts`.
5. Update CLAUDE.md and `docs/operations/local-debug-environment.md` references.
6. Mark TODO §"AskUserQuestion remote relay" with a note pointing at this spec; the relay itself is not "redone", just its activation surface.

## 10. Open Questions

None blocking. Two minor:

- Should `<state_dir>/sessions/<request_id>/` also receive a per-session log file (next iteration)? Defer to the in-flight observability work (TODO Backlog §3); this spec is hook-only.
- If `cfg.spawn_command` already contains a `--settings <other>`, ours appends — CC's behavior with multiple `--settings` is "merge, later wins for conflicting keys". Hook entries are array-keyed under `hooks.PreToolUse`, so additive concat is the merge semantic. Acceptable; document in `docs/operations/local-debug-environment.md`.
