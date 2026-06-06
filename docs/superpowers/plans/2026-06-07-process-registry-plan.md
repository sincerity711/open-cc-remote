# Process Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a daemon-local, reconcile-only registry of tmux sessions persisted at
`<state_dir>/runtime/tmux-sessions.json`, plus actually-kill-the-tmux behavior in the
`kill_session` handler. Eliminates orphan `cc-*` tmuxes after daemon crashes and
fixes the latent bug where the PWA "kill" button only severed the plugin socket
but left the `claude` process running.

**Architecture:** New `packages/daemon/src/process-registry.ts` exposes a small
async-serialized API (`add`, `remove`, `list`, `reconcile`) backed by an
atomic-rename JSON file. `packages/daemon/src/index.ts` calls `registry.reconcile()`
once at boot before `startHubClient`, awaits `registry.add(...)` after every
successful tmux spawn, and `tmux kill-session` + fire-and-forget `registry.remove(...)`
on every `kill_session` frame. No proto / hub / PWA changes.

**Tech Stack:** Bun + TypeScript, `bun:test`. Tests inject a fake
`listAliveTmuxSessions` so `tmux` is never invoked under test.

**Reference:** Spec at `docs/superpowers/specs/2026-06-07-process-registry-design.md`.

---

## File Map

**Create:**
- `packages/daemon/src/process-registry.ts` — registry module (read / atomic-write / serialized add+remove / reconcile / `listAliveTmuxSessions` helper)
- `packages/daemon/tests/process-registry.test.ts` — unit coverage per spec §"Testing strategy"

**Modify:**
- `packages/daemon/src/index.ts` — three hook points (boot reconcile, spawn add, kill hook rewrite)

**Untouched:** `packages/proto`, `packages/hub`, `packages/pwa`, `packages/plugin`,
`packages/daemon/src/registry.ts` (LiveSessions). Spec is explicit on this: zero
hub / PWA / proto changes for #2.

---

## Task 1 — Implement `process-registry.ts` module

**Files:**
- Create: `packages/daemon/src/process-registry.ts`

- [ ] **Step 1: Define the public types and constants**

Mirror the spec §"Implementation contract" verbatim:

```ts
export interface TmuxSessionEntry {
  tmux_name: string;
  cwd: string;
  spawn_command: string;
  created_at_ms: number;
  request_id: string | null;
}

export interface TmuxSessionRegistryFile {
  version: 1;
  sessions: TmuxSessionEntry[];
}

export interface ProcessRegistry {
  add(entry: TmuxSessionEntry): Promise<void>;
  remove(tmux_name: string): Promise<void>;
  list(): Promise<TmuxSessionEntry[]>;
  reconcile(opts?: {
    listAlive?: () => Promise<Set<string>>;
  }): Promise<{ kept: number; dropped: number }>;
}

export const REGISTRY_RELATIVE_PATH = path.join("runtime", "tmux-sessions.json");
export function resolveRegistryPath(stateDir: string): string;
```

- [ ] **Step 2: Implement the atomic write helper**

One private `mutate(fn)` helper that:
1. `mkdir -p` of `dirname(path)` (idempotent, swallows EEXIST).
2. Reads current file. If missing → `{version:1, sessions:[]}`. If unparseable → log warning via injected `log`, treat as empty.
3. Calls `fn(state)` to get next state.
4. Writes `path + ".tmp"` then `rename(tmp, path)`. The `.tmp` is always overwritten — never read as fallback (acceptance criterion §9).

- [ ] **Step 3: Serialize concurrent calls**

Inside the closure returned by `createProcessRegistry`, keep a `chain: Promise<void>` and have every public method (`add`, `remove`, `list`, `reconcile`) chain off it: `chain = chain.then(() => doWork())`. Guarantees no two file I/O operations interleave (acceptance criterion §10 — concurrent adds preserve all entries).

- [ ] **Step 4: Implement `listAliveTmuxSessions`**

Spawn `tmux list-sessions -F '#{session_name}'`, capture stdout. Per spec:
- Exit ≠ 0 with stderr matching `/no server running/i` → return empty `Set<string>`.
- Exit ≠ 0 with `ENOENT` (tmux binary missing) → throw, caller decides.
- Exit ≠ 0 anything else → throw, caller decides.
- Exit = 0 → split stdout on `\n`, filter empties, return as `Set`.

- [ ] **Step 5: Implement `reconcile`**

Default `opts.listAlive = listAliveTmuxSessions`. Inside the serialized chain:
- Try `await listAlive()`. If it throws, log warning, return `{kept: current.length, dropped: 0}` WITHOUT rewriting the file (fail-safe — spec §"Testing strategy" case 6).
- Otherwise, partition current entries by `alive.has(e.tmux_name)`. Survivors become next state. Always rewrite the file even if no entries dropped (so a missing file is materialized — spec §"Testing strategy" case 3).
- Return `{kept: survivors.length, dropped: current.length - survivors.length}`.

**Acceptance:**
- File compiles under `tsc --noEmit`.
- All public methods listed in `ProcessRegistry` exist with the spec'd signatures.
- No top-level side effects (no file I/O at import time).

---

## Task 2 — Write unit tests for `process-registry.ts`

**Files:**
- Create: `packages/daemon/tests/process-registry.test.ts`

Style reference: `packages/daemon/tests/jsonl-history.test.ts` (`mkdtempSync` per
test, sync cleanup, no global state). The spec mentions `slash-inventory.test.ts`
but that file does not exist in this branch — `jsonl-history.test.ts` follows the
same idiom and is the closest extant analog.

- [ ] **Step 1: Test scaffolding**

```ts
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createProcessRegistry,
  resolveRegistryPath,
} from "../src/process-registry.ts";

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "ccr-pr-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
```

- [ ] **Step 2: Cover all 10 cases from spec §"Testing strategy"**

1. `add` then `list` round-trips
2. `remove` of unknown name is a no-op
3. `reconcile` with missing file creates `{version:1, sessions:[]}`
4. `reconcile` all-alive: 3 entries + injected `listAlive` returning the same 3 → `{kept:3, dropped:0}`
5. `reconcile` partial drop: 3 entries + alive=2 → `{kept:2, dropped:1}`, file rewritten
6. `reconcile` `listAlive` throws ENOENT → `{kept:N, dropped:0}`, no removal
7. `reconcile` "no server running" → `listAlive` returns empty set → all dropped
8. Corrupt JSON on disk → reconcile logs warning, treats as empty, no throw
9. Atomic-write: pre-seed `tmux-sessions.json.tmp` with garbage, run `add` → `tmux-sessions.json` is valid and `.tmp` was overwritten not read
10. Concurrent add: `Promise.all([add×5])` without awaiting individually → final file has all 5 entries

`tmux` is never invoked. Cases that need `listAlive` semantics inject a fake via
`reconcile({listAlive: async () => ...})`. Case 6 specifically uses
`async () => { throw Object.assign(new Error("ENOENT"), {code:"ENOENT"}); }`.

- [ ] **Step 3: Run the suite**

```
bun test packages/daemon/tests/process-registry.test.ts
```

**Acceptance:** all 10 tests pass; no `tmux` binary invoked (verifiable by the
fact that all tests run with `listAlive` injected).

---

## Task 3 — Wire registry into daemon boot (reconcile hook)

**Files:**
- Modify: `packages/daemon/src/index.ts` (around line 120, before `const hub = startHubClient(...)`)

- [ ] **Step 1: Construct registry and reconcile**

Note: the actual `startHubClient` call is at `index.ts:120` in this branch (spec
references line 182, which is stale — the file has been edited since). Insert
immediately above:

```ts
import { createProcessRegistry } from "./process-registry.ts";

const registry = createProcessRegistry({
  stateDir: cfg.state_dir,
  log: (m) => process.stderr.write(`daemon: ${m}\n`),
});
{
  const { kept, dropped } = await registry.reconcile();
  process.stderr.write(`daemon: tmux registry reconciled (kept=${kept} dropped=${dropped})\n`);
}
```

The file is a top-level module and already uses top-level `await` (line 95:
`await getOrCreateKeypair(...)`), so this is fine.

**Acceptance:**
- Daemon boots cleanly with no registry file present (fresh install) — creates
  one with `{version:1, sessions:[]}`.
- Daemon boots cleanly with corrupt JSON — single warning, no crash (acceptance
  criterion §3 in spec).
- `tsc --noEmit` clean.

---

## Task 4 — Wire registry into spawn path (add hook)

**Files:**
- Modify: `packages/daemon/src/index.ts` (the `start_session` handler, around lines 204-246)

- [ ] **Step 1: Make the `onFrame` handler async-safe**

The current `onFrame` arrow at line 131 is non-async. The spec assumed it was
already async — it is not. Two options:
- (A) Mark it `async`. Safe — `startHubClient` doesn't await its return value.
- (B) Wrap the new `await registry.add(...)` in `void (async () => { ... })()`.

Use (A): change `onFrame: (frame: HubToDaemon) => {` to
`onFrame: async (frame: HubToDaemon) => {`. All existing branches return
synchronously and are unaffected.

Verify by grepping `hub-client.ts` for how `onFrame` is invoked — must not rely
on its return value.

- [ ] **Step 2: Insert `await registry.add` after `r.unref()`**

Inside the `start_session` branch, after `r.unref()` and the existing
`process.stderr.write` log line, before `dismissClaudeDialogs(tmuxName)`:

```ts
r.unref();
process.stderr.write(`daemon: spawned tmux session ${tmuxName} in ${cwd}\n`);
await registry.add({
  tmux_name: tmuxName,
  cwd,
  spawn_command: cfg.spawn_command,
  created_at_ms: Date.now(),
  request_id: null,  // HubToDaemonStartSession has no request_id field
});
dismissClaudeDialogs(tmuxName);
```

Note on `request_id`: spec text shows `request_id: requestId`, but
`HubToDaemonStartSession` (proto/frames.ts:151-155) does not carry a
`request_id`. Persist `null`. Forward-compat: schema already declares
`string | null`.

The existing `r.on("error", ...)` and `try/catch` branches do NOT call
`registry.add` — there's no tmux to track on spawn failure. (Spec §"spawn hook"
is explicit on this.)

**Acceptance:**
- After successful `start_session`, `<state_dir>/runtime/tmux-sessions.json`
  contains an entry with the matching `tmux_name`.
- Spawn failure does not write a registry entry.

---

## Task 5 — Rewrite `kill_session` handler (kill hook)

**Files:**
- Modify: `packages/daemon/src/index.ts` (the `kill_session` branch, around lines 191-203)

- [ ] **Step 1: Replace handler body**

Current code only calls `client.destroy()`. Replace per spec §"Kill hook":

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
    childSpawn("tmux", ["kill-session", "-t", tmuxName], { stdio: "ignore" })
      .on("error", () => {});
    void registry.remove(tmuxName);
  }
  try { client?.destroy(); } catch {}
}
```

Key differences vs current code:
1. Looks up `SessionSnapshot.tmux_session` via `sessions.get(...)` (the LiveSessions
   from `registry.ts`) — already populated from plugin's `TMUX_SESSION` env at
   `plugin/src/session.ts:19`. No new schema needed.
2. Guard widened: previously bailed on `!client` only. Now bails only when BOTH
   `session` and `client` are missing — covers the case where the plugin socket
   already dropped but the snapshot is still cached, so we can still kill the
   tmux.
3. `tmux kill-session` is fire-and-forget (`.on("error", () => {})` swallows
   ENOENT / "no server" / "session not found").
4. `registry.remove` is `void`-ed: kill latency stays under one tick; next
   reconcile sweeps if this write happens to fail.
5. `client?.destroy()` runs LAST so the plugin sees EOF; tmux kill above ends
   `claude` independently of the socket teardown.

**Acceptance:**
- `cfg.allow_kill === false` → still ignored, no tmux invocation.
- `tmux_session === null` (manual non-tmux session) → plugin socket destroyed,
  no tmux call (acceptance criterion §6 in spec).
- `tmux_session` present → tmux dies AND registry entry removed.

---

## Task 6 — Run full test + typecheck sweep, commit

**Files:** none (verification + commit only)

- [ ] **Step 1: Run daemon tests**

```
bun test packages/daemon/
```

All existing tests must still pass. Note any pre-existing breakage in the
commit message body but do not fix unrelated tests.

- [ ] **Step 2: Smoke-test the other workspace tests**

```
bun test packages/proto/
bun test packages/hub/
bun test packages/pwa/
```

These touch zero files we changed; they should be a no-op pass. If any of
them was already broken on `main`, leave it.

- [ ] **Step 3: Typecheck**

```
bun run typecheck
```

Must be clean across all packages.

- [ ] **Step 4: Commit**

Single commit, conventional-commits style, no push:

```
git add packages/daemon/src/process-registry.ts \
        packages/daemon/src/index.ts \
        packages/daemon/tests/process-registry.test.ts \
        docs/superpowers/specs/2026-06-07-process-registry-design.md \
        docs/superpowers/plans/2026-06-07-process-registry-plan.md
git commit -m "feat(daemon): process registry — reconcile-only on boot, fix kill_session leak (#2)"
```

**Acceptance:**
- `git log --oneline -5` shows the new commit on top of `main`'s recent history.
- Diffstat: ~120 LOC new in `process-registry.ts`, ~25 LOC changed in `index.ts`,
  ~150 LOC of tests, plus the spec + plan docs.

---

## Out of scope (per spec §"Out of scope")

- Windows support (`taskkill` branch dropped).
- PID / process-group tracking — tmux is the right unit.
- Killing CC processes inside a still-alive tmux session (separate health-check
  concern, future spec).
- Adopting orphan tmuxes the daemon didn't create.
- Hub / PWA / proto changes — none required.
