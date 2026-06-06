# Process Registry Design — daemon tmux-session reconciliation

**Status**: draft, awaiting user review
**Origin**: `docs/TODO.md` "AionUi 借鉴 6 项" item #2.
**Reference impl**: `/Users/i060912/SAPDevelop/AionUi/packages/web-host/src/agent-process-registry.ts` (157 lines).

---

## Problem

`start_session` in `packages/daemon/src/index.ts:336-353` spawns a detached `tmux new-session`, calls `r.unref()`, and returns. There is **no record on disk** that the tmux session exists. `grep -E 'registry|registered|cleanup' packages/daemon/src` returns 0 hits for any process / tmux registry.

Consequences:

1. **Daemon crash leaves stranded tmux sessions.** A fresh daemon has no idea which `cc-*` tmuxes belong to it. The PWA's session list (driven by `LiveSessions`, populated by plugin `register` frames) repopulates only when CC re-attaches; until then the user has zombie tmuxes that nobody can kill from the UI. `tmux kill-session` from the CLI is the only escape.
2. **`kill_session` does not actually kill the tmux.** `index.ts:300-312` handles the frame by calling `client.destroy()` on the plugin's Unix socket. That tears down the daemon ↔ plugin pipe, but the tmux session — and the `claude` process inside it — keeps running. A latent bug; user-visible as "I clicked kill and the session reappeared on next refresh."
3. **No graceful invariant.** Whatever cleanup we add for #1 must not nuke healthy long-running tmuxes during routine daemon restarts (config change, version upgrade). The user explicitly chose "保留所有活的".

AionUi solved a similar problem with a JSON-on-disk registry of PIDs / process groups + SIGTERM-then-SIGKILL on startup. Our shape is different — tmux is the right boundary (not PID), and "kill on startup" is wrong (we want reconcile, not nuke). Same idea, different policy.

## Decision

A **reconcile-only registry** persisted at `<state_dir>/runtime/tmux-sessions.json`. Three hook points:

- **Boot** (before `startHubClient`): list known tmux server sessions; drop registry entries whose `tmux_name` is gone; rewrite the file. Survivors stay running.
- **Spawn** (after `r.unref()` in `start_session`): atomic-add a new entry with `{tmux_name, cwd, spawn_command, created_at_ms, request_id}`. Must complete **before** the daemon emits any reply to the hub, so a racing `kill_session` can find the entry.
- **Kill** (in `kill_session` branch): run `tmux kill-session -t <tmux_name>` (failure ignored — already-gone is the desired terminal state), then `await registry.remove(tmux_name)`. Also fixes the latent #2 bug above.

Registry **never starts a process** and **never kills a living one on startup**. It only records and reconciles. Process supervision is tmux's job; we observe.

### Why tmux session names, not PIDs

The reference impl tracks `pid + process_group_id`. We deliberately don't:

- The tmux server reparents new-sessions to itself; the spawn child PID exits immediately. There is no stable PID to kill.
- The right unit of work is the tmux session — that's what the user sees in `tmux ls`, what the PWA's session card represents, and what `tmux kill-session` operates on.
- `tmux list-sessions` is our authoritative liveness oracle. PID / process-group checks would be redundant and racy.

## Registry schema

`<state_dir>/runtime/tmux-sessions.json`:

```ts
interface TmuxSessionEntry {
  tmux_name: string;          // tmux session name, e.g. "cc-1730000000000"
  cwd: string;                // resolved cwd passed to tmux -c
  spawn_command: string;      // cfg.spawn_command at spawn time (audit only)
  created_at_ms: number;
  request_id: string | null;  // start_session request id, or null if absent
}

interface TmuxSessionRegistry {
  version: 1;
  sessions: TmuxSessionEntry[];
}
```

Unknown / extra fields on disk are tolerated (forward-compat). Missing or unparseable file → treated as `{version: 1, sessions: []}` with a single warning log line. **Corrupt JSON never aborts daemon boot.**

Atomic write: `writeFile(path + ".tmp", ...)` then `rename(tmp, path)`. Same idiom as `cc-remote pair` config rewrite.

Note: this schema does **not** carry the daemon `session_id`. At spawn time the daemon-side `session_id` doesn't exist yet — it's minted by the plugin and arrives via `register` (`index.ts:748-752`). The session_id ↔ tmux_name binding lives on `SessionSnapshot.tmux_session`, populated from `TMUX_SESSION` env var inside the plugin (`packages/plugin/src/session.ts:19`). `kill_session` resolves it via `sessions.get(session_id)?.tmux_session` — see "Kill hook" below.

## Implementation contract

### `packages/daemon/src/process-registry.ts` (new, ~120 lines)

```ts
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

export interface TmuxSessionEntry {
  tmux_name: string;
  cwd: string;
  spawn_command: string;
  created_at_ms: number;
  request_id: string | null;
}

export interface ProcessRegistry {
  add(entry: TmuxSessionEntry): Promise<void>;
  remove(tmux_name: string): Promise<void>;
  list(): Promise<TmuxSessionEntry[]>;
  reconcile(opts?: { listAlive?: () => Promise<Set<string>> }): Promise<{ kept: number; dropped: number }>;
}

export const REGISTRY_RELATIVE_PATH = path.join("runtime", "tmux-sessions.json");

export function resolveRegistryPath(stateDir: string): string {
  return path.join(stateDir, REGISTRY_RELATIVE_PATH);
}

export function createProcessRegistry(opts: {
  stateDir: string;
  log?: (m: string) => void;
}): ProcessRegistry { /* ... */ }

export async function listAliveTmuxSessions(): Promise<Set<string>> {
  // tmux list-sessions -F '#{session_name}'
  // Exit code != 0 with stderr "no server running" → empty set, NOT an error.
  // Any other failure → log warning, return empty set (fail-safe: nothing
  // gets reconciled-out on a transient tmux error; entries persist).
}
```

Critical invariants:

- `add()` and `remove()` serialize via an internal `Promise` chain so concurrent calls don't lose writes.
- All file I/O goes through one private `readFile` → mutate → atomic `writeFile + rename` helper. No partial-write window.
- `reconcile` is the only operation that touches `listAliveTmuxSessions`. `add`/`remove` never shell out.

### `packages/daemon/src/index.ts` — boot hook

Insert **before** `const hub = startHubClient(...)` at `index.ts:182`:

```ts
const registry = createProcessRegistry({
  stateDir: cfg.state_dir,
  log: (m) => process.stderr.write(`daemon: ${m}\n`),
});
{
  const { kept, dropped } = await registry.reconcile();
  process.stderr.write(`daemon: tmux registry reconciled (kept=${kept} dropped=${dropped})\n`);
}
```

Reasoning for ordering: the hub never sees a session list that includes already-dead tmuxes. If we reconciled after `bindHub` we could (a) advertise dead sessions to PWA, (b) race with a `kill_session` from a freshly-connected PWA against an entry the registry is about to drop.

### `packages/daemon/src/index.ts` — spawn hook (replace `index.ts:336-370`)

After `r.unref()` and the `dismissClaudeDialogs(tmuxName)` call, **`await` registry add before any further work**:

```ts
r.unref();
process.stderr.write(`daemon: spawned tmux session ${tmuxName} in ${cwd}\n`);
pendingStarts.add(requestId ?? undefined, cwd);
await registry.add({
  tmux_name: tmuxName,
  cwd,
  spawn_command: cfg.spawn_command!,
  created_at_ms: Date.now(),
  request_id: requestId,
});
dismissClaudeDialogs(tmuxName);
```

The `r.on("error", ...)` branch (spawn_failed) does **not** call `registry.add` — there is no tmux to track. Same for the outer `catch (e)` (spawn threw synchronously).

The `start_session` handler is already inside an `async` arrow on `onFrame`. Awaiting registry.add adds a single fs round-trip (~1ms) before reply is sent — well below the human-perceptible threshold and gating future `kill_session` lookups.

### `packages/daemon/src/index.ts` — kill hook (replace `index.ts:300-312`)

```ts
else if (frame.type === "kill_session") {
  if (!cfg.allow_kill) {
    process.stderr.write(`daemon: kill_session ignored (allow_kill=false in config)\n`);
    return;
  }
  const session = sessions.get(frame.session_id);
  const tmuxName = session?.tmux_session ?? null;
  const client = sessionToClient.get(frame.session_id);
  if (!session && !client) {
    process.stderr.write(`daemon: kill_session for unknown session ${frame.session_id}\n`);
    return;
  }
  process.stderr.write(`daemon: killing session ${frame.session_id} tmux=${tmuxName ?? "<unknown>"}\n`);
  if (tmuxName) {
    // Best-effort. tmux exits non-zero if the session already vanished — fine.
    childSpawn("tmux", ["kill-session", "-t", tmuxName], { stdio: "ignore" })
      .on("error", () => {});
    void registry.remove(tmuxName);
  }
  try { client?.destroy(); } catch {}
}
```

Notes:

- We rely on `SessionSnapshot.tmux_session` being non-null. Plugin populates it from `TMUX_SESSION` env (`plugin/src/session.ts:19`); a session spawned by `start_session` will have it set. A session NOT spawned by us (manual `claude` outside tmux) will have `tmux_session === null`; we still tear down the plugin socket but skip the tmux kill — correct, because there's nothing tmux-shaped to kill.
- `client.destroy()` last so the plugin gets the EOF; the tmux kill above will end the `claude` process inside it independently.
- We don't `await` registry.remove — the file write is non-critical for correctness (next reconcile drops it if missed) and we want kill latency to stay under one tick.

## Frame schema

**No proto changes.** Registry is daemon-internal state; the PWA never sees it.

If a future spec wants to expose "stranded tmuxes detected on boot" to the PWA (so the user can opt-in adopt them), that's additive and out of scope here.

## File-by-file changes

| File | Change |
|---|---|
| `packages/daemon/src/process-registry.ts` (new, ~120 LoC) | `createProcessRegistry` + `listAliveTmuxSessions` + `resolveRegistryPath` + atomic-write helper. |
| `packages/daemon/src/index.ts:182` | Insert registry construction + `await registry.reconcile()` before `startHubClient`. |
| `packages/daemon/src/index.ts:300-312` | Rewrite `kill_session` handler per "Kill hook" above. Adds `tmux kill-session` + `registry.remove`. |
| `packages/daemon/src/index.ts:336-370` | Add `await registry.add(...)` after `r.unref()`. |
| `packages/daemon/tests/process-registry.test.ts` (new) | Unit cases listed under "Testing strategy". |
| `packages/daemon/src/registry.ts` | **Unchanged.** session_id ↔ tmux_name lookup goes through `LiveSessions.get(session_id).tmux_session`, which already exists. |

Net: ~120 lines new, ~25 lines changed in `index.ts`, ~150 lines of tests.

## Out of scope

- **Windows.** We run darwin/linux. Reference impl's `taskkill` branch is dropped.
- **PID / process-group tracking.** tmux server reparents; PIDs are not stable. Section "Why tmux session names, not PIDs" above.
- **Killing CC processes inside a still-alive tmux session.** If a tmux session lives but `claude` inside it crashed, that's a separate health-check concern (next-spec material). Reconciling on tmux session presence alone leaves `tmux ls`-visible-but-dead-CC sessions in the registry — acceptable; user can re-attach and see what happened.
- **Crash detection of CC.** No heartbeat from inside tmux to daemon beyond the existing plugin socket; if CC dies the plugin closes and `LiveSessions` drops the snapshot — the tmux entry persists in our registry as long as `tmux ls` shows it. Correct: an empty tmux session is a thing the user might want to recover.
- **Adopting orphan tmuxes.** A `cc-*` tmux that is alive but absent from the registry (e.g. created by a different daemon instance) is left untouched. We never delete tmux sessions we didn't add.

## Testing strategy

`packages/daemon/tests/process-registry.test.ts` — same idiom as `slash-inventory.test.ts` (`mkdtempSync` per test, no global state, sync cleanup).

Cases:

1. **`add` then `list`** — write one entry; readback equals input.
2. **`remove` of unknown name** — no-op, no exception.
3. **`reconcile` with missing file** — returns `{kept: 0, dropped: 0}`, file is created at `runtime/tmux-sessions.json` with `{version:1, sessions:[]}`.
4. **`reconcile` all alive** — 3 entries, mock `listAliveTmuxSessions` returns the same 3 names → `{kept:3, dropped:0}`, file unchanged contents-wise.
5. **`reconcile` partial drop** — 3 entries, mock returns 2 → `{kept:2, dropped:1}`, file rewritten with the survivors.
6. **`reconcile` tmux command absent** — mock throws `ENOENT` → fail-safe: `{kept:N, dropped:0}` (no entries removed on a transient tmux failure), warning logged.
7. **`reconcile` "no server running"** — mock returns empty set (the legitimate empty-tmux state) → all entries dropped. Distinguished from #6 by mocking different exit semantics.
8. **Corrupt JSON on disk** — write `"{not json"` to the registry path; `reconcile` logs warning, treats as empty, continues without throwing.
9. **Atomic-write crash mid-rename** — pre-seed `tmux-sessions.json.tmp` with stale content; verify next `add` overwrites it cleanly (the `.tmp` is always treated as scratch, never as fallback).
10. **Concurrent `add` calls** — kick off 5 `add` calls in parallel without awaiting; final file contains all 5 entries (serialization invariant).

`tmux` is **not** invoked from these tests. `listAliveTmuxSessions` is injected via `reconcile({listAlive: ...})`.

Integration test (manual, documented in spec):

- `tools/demo-channel.sh up`, spawn a session from PWA, verify `~/.cc-remote/runtime/tmux-sessions.json` contains it.
- `pkill -9 daemon` (no graceful shutdown), restart daemon, verify the entry survives reconcile and `tmux ls` still shows the session.
- Click "kill" in PWA, verify `tmux ls` no longer lists the session AND the registry file no longer contains it.

## Migration / compatibility

- **First boot after upgrade**: registry file does not exist. Reconcile creates an empty one. Existing tmux sessions on the box are untouched (we never delete what we didn't track). User can keep using them; next time they spawn from PWA, that one gets registered.
- **Downgrade**: old daemon ignores the file. New file format is forward-compat (extra fields tolerated), so a re-upgrade picks up where it left off minus any entries the old daemon would have created without registering.
- **No deployment ordering** — registry is daemon-local; hub and PWA do not know it exists.

## Acceptance criteria

1. `kill -9` the daemon mid-session, restart it: `~/.cc-remote/runtime/tmux-sessions.json` post-reconcile contents equal `tmux ls | awk '{print $1}'` for `cc-*` names that the daemon previously spawned.
2. PWA "kill session" button results in the named tmux disappearing from `tmux ls` within 1 second AND the registry entry is gone.
3. With registry file pre-corrupted (`echo 'garbage' > tmux-sessions.json`), daemon boots cleanly with one warning line; subsequent `start_session` works and rewrites the file with valid JSON.
4. With `tmux` binary uninstalled, daemon boots cleanly (warning logged); `start_session` still fails the same way it did before this spec (no new failure mode introduced).
5. No existing test in `packages/daemon/tests/` regresses.
6. `kill_session` for a session whose `tmux_session` is null (manual / non-tmux session) tears down the plugin socket and skips tmux kill silently — same behavior as today plus the registry-aware no-op.

## Open questions

None. Algorithm, schema, hook points, and failure modes are decided. Spec is implementation-ready.
