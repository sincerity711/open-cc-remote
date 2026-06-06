# AgentHandshake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to work this plan task-by-task.

**Goal:** End-to-end implementation of TODO #3 — daemon probes the local `claude` binary (version, modes, default mode, capability bits) plus the existing slash inventory, and broadcasts an `agent_handshake` frame per session. Hub fans-out and replays. PWA stores the handshake, mirrors `available_commands` to the legacy `slashInventory` slice (zero churn for SlashMenu callers), and renders a read-only Agent card in SettingsDrawer.

**Reference spec:** `docs/superpowers/specs/2026-06-07-agent-handshake-design.md`.

**Architecture:** New `agent_handshake` frame in `DaemonToHub` and `HubToPwa` unions, mirroring the shape of `slash_inventory` (broadcast-once per session register, hub caches, replay on PWA subscribe and on hub reconnect). Daemon-side probe is a module-level cached Promise so concurrent boots never double-spawn `claude`. Legacy `slash_inventory` is kept (deprecation comment only) and the PWA reducer auto-mirrors `available_commands` into the existing `slashInventory` state slice so SessionView's `slashEntries` prop wiring is untouched.

---

## Pre-conditions verified (against branch `feat/agent-handshake` @ b944808)

- `packages/proto/src/frames.ts:144` — `DaemonToHub` union has `DaemonSlashInventory`.
- `packages/proto/src/frames.ts:188` — `HubToPwa` union has `PwaSlashInventory`.
- `packages/proto/src/frames.ts:417-428` — `DaemonSlashInventory` + `PwaSlashInventory` declarations.
- `packages/daemon/src/index.ts:179` — `slashInventoryBySession` cache.
- `packages/daemon/src/index.ts:213-214` — onOpen replay loop.
- `packages/daemon/src/index.ts:640-647` — per-session emit site (after `bind_resolved`).
- `packages/daemon/src/index.ts:702` — cleanup on session remove.
- `packages/hub/src/router.ts:37` — `DaemonState.slashInventory` field.
- `packages/hub/src/router.ts:87` — initial state in `hello`.
- `packages/hub/src/router.ts:111` — clear on session_close.
- `packages/hub/src/router.ts:265-276` — `slash_inventory` case in `onDaemonFrame`.
- `packages/hub/src/router.ts:329-343` — `onPwaSubscribe` replay loop.
- `packages/pwa/src/hooks/useHub.ts:120` — `slashInventory` field.
- `packages/pwa/src/hooks/useHub.ts:136` — initial state.
- `packages/pwa/src/hooks/useHub.ts:545-551` — reducer case for `slash_inventory`.
- `packages/pwa/src/hooks/useSlashInventory.ts` — exists (16 lines, pure selector).
- `packages/pwa/src/screens/SettingsDrawer.tsx` — exists (498 lines, dumb component receiving everything via props).
- `packages/pwa/src/RealApp.tsx:215` — only callsite; pure prop drilling.

All cited sites still match the spec. Proceed.

---

## File Map

**Create:**
- `packages/daemon/src/agent-probe.ts` — probe module + module-level cache + version compare helper
- `packages/daemon/tests/agent-probe.test.ts` — unit tests with injected fake spawn + tmp HOME/cwd
- `packages/pwa/src/hooks/useAgentCapabilities.ts` — pure selector mirroring `useSlashInventory.ts`
- `packages/pwa/src/hooks/useAgentCapabilities.test.ts` — reducer + selector tests

**Modify:**
- `packages/proto/src/frames.ts` — add `AgentCapabilityBits`, `DaemonAgentHandshake`, `PwaAgentHandshake`, extend unions, deprecate `*SlashInventory`
- `packages/proto/tests/frames.test.ts` — round-trip tests for the new frames
- `packages/daemon/src/index.ts` — wire boot probe + per-session emit + replay map
- `packages/hub/src/router.ts` — `DaemonState.agentHandshake` map + `agent_handshake` case + replay loop + cleanup
- `packages/hub/tests/router.test.ts` — hub fan-out + replay coverage
- `packages/pwa/src/hooks/useHub.ts` — `agentHandshakes` state + reducer case + slashInventory mirror
- `packages/pwa/src/screens/SettingsDrawer.tsx` — read-only Agent section + new optional prop
- `packages/pwa/src/RealApp.tsx` — pass agent handshake into SettingsDrawer (selected daemon's most recent)
- `packages/pwa/src/demo/DemoApp.tsx` — stub the new prop

**Untouched:** plugin, daemon SlashMenu source path, push pipeline, e2e-real (out of scope per request).

---

## Task 1 — Proto: add frame types and round-trip tests

**Files:** `packages/proto/src/frames.ts`, `packages/proto/tests/frames.test.ts`.

**Steps:**

1. Append `AgentCapabilityBits`, `DaemonAgentHandshake`, `PwaAgentHandshake` near the existing `*SlashInventory` declarations (~line 428). Add JSDoc deprecation `@deprecated use agent_handshake.available_commands` on both `*SlashInventory` interfaces.
2. Extend `DaemonToHub` (line 144 area) and `HubToPwa` (line 188 area) unions with the new types.
3. Add round-trip tests in `frames.test.ts`:
   - `DaemonAgentHandshake round-trips` — assert all fields including `capabilities` survive `JSON.parse(JSON.stringify(...))`.
   - `PwaAgentHandshake carries daemon_id`.
   - Degraded handshake (`agent_version: null`, `default_mode: null`, empty `available_modes`) round-trips.

**Acceptance:** `bun test packages/proto/` is green; `grep agent_handshake packages/proto/src/frames.ts` shows the new union members.

---

## Task 2 — Daemon: agent-probe module + unit tests

**Files:** `packages/daemon/src/agent-probe.ts` (new), `packages/daemon/tests/agent-probe.test.ts` (new).

**Implementation:**

- Export `probeAgent(opts: { homeDir: string; cwd: string; spawn?: SpawnFn; readFile?: ReadFn }): Promise<AgentProbeResult>`. The optional `spawn` and `readFile` overrides are for tests; production uses `Bun.spawn` and `node:fs/promises#readFile`.
- Module-level `let cached: Promise<AgentProbeResult> | null = null` keyed on `homeDir` is **not** what we want — the spec calls for re-reading the project file per session. Strategy: cache the **CLI-derived** result (version + modes + capability bits) once per process, and read settings.json fresh each call (cheap). So the cache shape is `let cliCached: Promise<{ agent_version: string|null; available_modes: string[]; capabilities: AgentCapabilityBits }> | null`. Final `AgentProbeResult` is `cliCached + default_mode` resolved per-call.
- `available_models` is hardcoded `["sonnet","opus","haiku"]`.
- Capability bits: hand-rolled `cmpVersion(a, b)` that returns -1/0/1. `supports_notification_hook = ver >= 2.1.146`, `jsonl_flush_quirk = ver >= 2.1.139`, `supports_ack = ver >= 2.1.150`, `has_mcp = true`, `has_plugin = true`. When `agent_version` is null, all version-gated bits are false; `has_mcp` and `has_plugin` stay true (they describe the daemon's own integration, not the binary).
- Settings precedence: project (`<cwd>/.claude/settings.json#permissions.defaultMode`) overrides user (`~/.claude/settings.json`). Read errors → treat as absent + `process.stderr.write` warning (only on parse error, not on ENOENT).
- `clearProbeCacheForTests()` resets `cliCached`.

**Test cases (with mock spawn + tmp dirs):**

1. Healthy `--help` + `--version` → modes parsed exactly, version-gated bits correct (use `2.1.150` → ack/notification true, jsonl_flush_quirk true).
2. `--version` exit 1 → `agent_version: null`, version-gated bits false.
3. `--help` lacks the choices block → fallback hardcoded list.
4. No settings.json files → `default_mode: null`.
5. Project `settings.json` overrides user.
6. Malformed project JSON → falls back to user file, stderr warning.
7. Two concurrent `probeAgent()` calls share one spawn (assert spawn count === 2 after first call: one `--version` + one `--help`).

**Acceptance:** `bun test packages/daemon/tests/agent-probe.test.ts` passes; cache invariant holds (concurrent callers spawn `claude` exactly twice total).

---

## Task 3 — Daemon: wire probe into index.ts

**Files:** `packages/daemon/src/index.ts`.

**Steps:**

1. Import `probeAgent` from `./agent-probe.ts`.
2. Add `const agentHandshakeBySession = new Map<string, Omit<DaemonAgentHandshake, "type" | "session_id">>()` next to `slashInventoryBySession` (~line 179).
3. In `onOpen` (after the slash_inventory replay loop, ~line 215), add:
   ```ts
   for (const [session_id, payload] of agentHandshakeBySession) {
     out.push({ type: "agent_handshake", session_id, ...payload });
   }
   ```
4. At the per-session emit site (after `hub.send({ type: "slash_inventory", ... })` at line 643), `await probeAgent({ homeDir: homedir(), cwd: s.cwd })` — first call kicks off the spawns; subsequent calls hit the cache. Build the payload and:
   - Send `{ type: "agent_handshake", session_id, ... }` via `hub.send`.
   - Store the body in `agentHandshakeBySession`.
   - Wrap the whole probe in a `try/catch` so a probe failure does not crash the slash_inventory `.then()` callback.
5. In `sessions.onRemove` at line 702, also `agentHandshakeBySession.delete(session_id)`.

**Acceptance:** Manual: starting daemon with the demo harness emits an `agent_handshake` frame per session register (verify by daemon log or wireshark). `bun test packages/daemon/` stays green.

---

## Task 4 — Hub: route, cache, replay

**Files:** `packages/hub/src/router.ts`, `packages/hub/tests/router.test.ts`.

**Steps:**

1. Import `DaemonAgentHandshake`, `PwaAgentHandshake` from `@cc-remote/proto`.
2. Extend `DaemonState` (line 38) with `agentHandshake: Map<string, Omit<DaemonAgentHandshake, "type" | "session_id">>`.
3. Initialize in the `hello` handler (line 87) → `agentHandshake: new Map()`.
4. In `session_close` (line 111) → `state.agentHandshake.delete(frame.session_id)`.
5. New `case "agent_handshake":` after the `slash_inventory` case (~line 276):
   ```ts
   case "agent_handshake": {
     const state = this.daemons.get(daemon_id);
     if (!state) return;
     const { type: _t, session_id, ...rest } = frame;
     state.agentHandshake.set(session_id, rest);
     this.pwaReg.broadcast({ type: "agent_handshake", daemon_id, session_id, ...rest });
     return;
   }
   ```
6. In `onPwaSubscribe` (line 333), add a parallel loop:
   ```ts
   for (const [session_id, rest] of d.agentHandshake) {
     send({ type: "agent_handshake", daemon_id: d.daemon_id, session_id, ...rest });
   }
   ```
7. Add hub tests mirroring the slash_inventory test:
   - "daemon agent_handshake is broadcast to PWAs with daemon_id added"
   - "agent_handshake is replayed on onPwaSubscribe"
   - "agent_handshake is cleared on session_close"

**Acceptance:** `bun test packages/hub/tests/router.test.ts` passes including new tests.

---

## Task 5 — PWA reducer + selector hook

**Files:** `packages/pwa/src/hooks/useHub.ts`, `packages/pwa/src/hooks/useAgentCapabilities.ts` (new), `packages/pwa/src/hooks/useAgentCapabilities.test.ts` (new).

**Steps:**

1. In `HubState` (line 121), add `agentHandshakes: Record<string, PwaAgentHandshake>`.
2. In `initialHubState()` (line 137), `agentHandshakes: {}`.
3. New reducer case after `slash_inventory` (~line 552):
   ```ts
   case "agent_handshake": {
     const k = eventKey(frame.daemon_id, frame.session_id);
     return {
       ...prev,
       agentHandshakes: { ...prev.agentHandshakes, [k]: frame },
       // Mirror so legacy SlashMenu callers keep working unchanged.
       slashInventory: { ...prev.slashInventory, [k]: frame.available_commands },
     };
   }
   ```
4. New `useAgentCapabilities.ts`:
   ```ts
   export function selectAgentCapabilities(
     state: Pick<HubState, "agentHandshakes">,
     daemon_id: string,
     session_id: string,
   ): PwaAgentHandshake | null {
     return state.agentHandshakes[eventKey(daemon_id, session_id)] ?? null;
   }
   ```
5. Tests:
   - Frame routes into `agentHandshakes` keyed correctly.
   - Same frame mirrors `available_commands` into `slashInventory`.
   - Selector returns `null` when no frame yet.

**Acceptance:** `bun test packages/pwa/` passes including new test; existing `useSlashInventory.test.ts` continues to pass.

---

## Task 6 — PWA UI: Agent card in SettingsDrawer

**Files:** `packages/pwa/src/screens/SettingsDrawer.tsx`, `packages/pwa/src/RealApp.tsx`, `packages/pwa/src/demo/DemoApp.tsx`.

**Steps:**

1. Add an optional prop `agent?: PwaAgentHandshake | null` to `SettingsDrawerProps`.
2. Render a new `<Section title="Agent">` between Notifications (line 95) and Appearance (line 111). Layout:
   - `Version: {agent.agent_version ?? "—"}`
   - Modes row: chip per mode, default mode highlighted
   - Models row: 3 chips
   - Capability bits: ✓/✗ per bit, label each
   - When `agent` is null: render a single `<p className="text-muted-foreground text-sm">No live session — start one to see capabilities.</p>`
3. In `RealApp.tsx`, derive `selectedAgent` via `selectAgentCapabilities(hub, selected.daemon_id, selected.session_id)` when a session is selected; pass undefined otherwise. Settings drawer is global, so when user opens settings without a selected session we just pass `null`.
4. In `DemoApp.tsx`, stub `agent={null}` so the demo doesn't crash; existing demo `SettingsDrawer` is a duplicate inline component (line 1591) — leave it alone since it has its own props shape.

**Acceptance:** `bun test packages/pwa/` green; manual visual check via running the dev server is out of scope here (covered by spec acceptance).

---

## Task 7 — Whole-package verification + commit

**Steps:**

1. `bun test packages/` — every package green, expect 533 baseline + ~15 new = ~548 passing.
2. `bun --bun tsc --noEmit -p packages/proto && bun --bun tsc --noEmit -p packages/daemon && bun --bun tsc --noEmit -p packages/hub && bun --bun tsc --noEmit -p packages/pwa` (or whatever the project's typecheck command is — check `package.json` scripts).
3. `git add` the modified + new files **plus** the spec file `docs/superpowers/specs/2026-06-07-agent-handshake-design.md` and this plan.
4. Single commit: `feat(handshake): probe claude version/modes/settings, fan out to PWA (#3)`.
5. `git checkout feat/ws-heartbeat` to restore the user's primary worktree state.
6. Confirm the other 3 specs (process-registry, thinking-collapse, resolved-permission-card) re-appear as untracked on `feat/ws-heartbeat` (they should, since we never staged them on `feat/agent-handshake`).

**Acceptance:** clean tests, clean typecheck, single commit on `feat/agent-handshake`, untracked spec siblings restored on `feat/ws-heartbeat`.

---

## Risks / non-goals

- **No live re-probe on CC auto-update** — restart the daemon. Out of scope.
- **No `--list-models` polling** — CC doesn't expose one.
- **No mode/model **switching** from PWA** — observe-only.
- **Probe timeout 2s** — guess; revisit if real deploys hit it.
- **Project settings.json read per session** — cheap, no caching layer; spec'd open question.
