# AgentHandshake — daemon-side capability probe surfaced to the PWA

**Status**: draft, awaiting user review
**Origin**: `docs/TODO.md` Phase 2 item #3 (AionUi-comparison borrow-list).
**Related**: `docs/research/aionui-comparison.md` §7 (decided: no ACP migration).

---

## Problem

The PWA today knows almost nothing about the agent on the other end:

- **Slash commands** flow as `slash_inventory` (`packages/proto/src/frames.ts:419`), but **modes**, **models**, **agent version**, and **runtime capability bits** are not advertised — `grep -E 'available_modes|available_models|agent_version' packages/proto/src` returns 0 hits outside `hello.agent_version` (which is hardcoded to `"0.1.0"` in `packages/daemon/src/index.ts:190`).
- The PWA cannot show "this daemon's CC is 2.1.165 with `bypassPermissions` default" without a roundtrip.
- Future features that gate on CC version (notification hook ≥2.1.146, jsonl flush regression ≥2.1.139, ack ≥2.1.150) have no source of truth to read.

A spike confirmed three things on `claude 2.1.165`:

1. **`claude --capabilities` does not exist** (exit 1, "unknown option").
2. **`claude --help`** reliably exposes `--permission-mode <mode>` choices `["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"]` — this is the source of `available_modes`.
3. **`~/.claude/settings.json`** carries `permissions.defaultMode`. There is **no** `model`/`models` field anywhere (model is a `--model` flag at session-start time and is not statically discoverable).

So the daemon must mix three signals (CLI help, version semver, settings.json) plus a hardcoded model alias list to assemble the metadata.

## Decision

Add a single broadcast frame `agent_handshake` emitted by the daemon **once per session** (right after `bind_resolved`, mirroring the existing `slash_inventory` emit at `packages/daemon/src/index.ts:643`) and replayed on hub reconnect.

The probe runs **once per daemon-process lifetime** at boot. Result is cached in memory; the per-session frame is the same payload wrapped in a `session_id` envelope. Per-session timing reuses the slash_inventory site so a fresh PWA subscriber gets the handshake through the same fan-out path. Live re-probe (CC binary auto-update mid-session) is out of scope — restart the daemon.

The existing `slash_inventory` frame is **kept as-is** for backwards compatibility; `agent_handshake.available_commands` carries the same `SlashEntry[]`. The PWA prefers handshake when present and falls back to legacy `slash_inventory`. Marking the legacy frame deprecated is a separate cleanup.

### Probe sequence

1. `claude --help` → regex-parse the `--permission-mode <mode>` choices line. Hardcoded fallback `["acceptEdits","auto","bypassPermissions","default","dontAsk","plan"]` if parse fails or binary missing.
2. `claude --version` → semver. Compute capability bits:
   - `supports_notification_hook = ver >= 2.1.146`
   - `jsonl_flush_quirk        = ver >= 2.1.139`
   - `supports_ack             = ver >= 2.1.150`
3. Read `~/.claude/settings.json` (user) and `<cwd>/.claude/settings.json` (project — project overrides user). Extract `permissions.defaultMode`. Both files optional; parse errors treated as "not present" with a stderr warning.
4. Hardcoded `available_models = ["sonnet","opus","haiku"]`. Document the limitation in the field's JSDoc.

If `claude` is not on `PATH`: emit handshake with `agent_version: null`, empty `available_modes`, and `default_mode: null`. Log a warning. Frame still flows so the PWA can render a degraded-state Agent card rather than getting stuck on a spinner.

## Frame schema

Add to `packages/proto/src/frames.ts`:

```ts
export interface AgentCapabilityBits {
  supports_notification_hook: boolean;
  supports_ack: boolean;
  jsonl_flush_quirk: boolean;
  /** Always true for CC ≥2.0; explicit so future agents can flip it. */
  has_mcp: boolean;
  /** `--plugin-dir` flag is present in 2.1.x; hardcoded true for now. */
  has_plugin: boolean;
}

export interface DaemonAgentHandshake {
  type: "agent_handshake";
  session_id: string;
  /** null when `claude` binary missing or `--version` parse failed. */
  agent_version: string | null;
  /** Parsed from `claude --help` (--permission-mode choices). May be empty
   *  when the binary is missing — UI degrades gracefully. */
  available_modes: string[];
  /** From settings.json `permissions.defaultMode`. Project overrides user. */
  default_mode: string | null;
  /** Hardcoded ["sonnet","opus","haiku"] — CC has no static model list. */
  available_models: string[];
  /** Same payload as the legacy `slash_inventory` frame. */
  available_commands: SlashEntry[];
  capabilities: AgentCapabilityBits;
}

export interface PwaAgentHandshake extends DaemonAgentHandshake {
  daemon_id: string;
}
```

Add `DaemonAgentHandshake` to the `DaemonToHub` union (next to `DaemonSlashInventory`); add `PwaAgentHandshake` to the `HubToPwa` union (next to `PwaSlashInventory`). Add a deprecation comment on both `*SlashInventory` types pointing at `agent_handshake.available_commands`.

## Implementation contract

### Daemon

`packages/daemon/src/agent-probe.ts` (new):

```ts
export interface AgentProbeResult {
  agent_version: string | null;
  available_modes: string[];
  default_mode: string | null;        // null when settings.json absent/unparseable
  available_models: string[];          // hardcoded
  capabilities: AgentCapabilityBits;
}

export async function probeAgent(opts: {
  homeDir: string;
  cwd: string;
  /** override for tests */
  spawn?: typeof Bun.spawn;
}): Promise<AgentProbeResult> { /* ... */ }

/** Module-level cache; populated on first call. */
export function clearProbeCacheForTests(): void;
```

Internals:

- `Bun.spawn(["claude","--version"], …)` with 2s timeout. Stdout regex `/^([\d.]+)\s/`. Failure → `agent_version = null`.
- `Bun.spawn(["claude","--help"], …)` with 2s timeout. Regex on the output: `/--permission-mode\s+<mode>[\s\S]*?choices?:\s*\[([^\]]+)\]/`. Split on `,`, strip quotes/whitespace. Failure → hardcoded list.
- `import("node:fs/promises").readFile` for both settings files — both errors swallowed → "absent".
- Capability bits via `semver.gte` (or hand-rolled compare; the project does not currently depend on `semver`, so prefer a 10-line `cmpVersion(a, b)` helper).
- Cache on a module-scoped `let cached: Promise<AgentProbeResult> | null = null` so concurrent boots do not double-spawn.

`packages/daemon/src/index.ts` changes:

1. Boot site (near the slash inventory wiring around line 175-179): kick off `probeAgent({homeDir: homedir(), cwd: process.cwd()})` and assign the awaited result to a module-scoped `agentProbe`. Do **not** block the hub connect on this — let it resolve in parallel; emit `agent_handshake` only once both probe is ready and the session has registered (an ordinary `await` inside the `sessions.onAdd` body is fine since the cache is hot after first call).
2. Per-session emit (immediately after the `slash_inventory` send at line 643):
   ```ts
   const probe = await probeAgent({homeDir: homedir(), cwd: s.cwd});
   hub.send({
     type: "agent_handshake",
     session_id: s.session_id,
     agent_version: probe.agent_version,
     available_modes: probe.available_modes,
     default_mode: probe.default_mode,
     available_models: probe.available_models,
     available_commands: entries,
     capabilities: probe.capabilities,
   });
   agentHandshakeBySession.set(s.session_id, /* full frame minus session_id */);
   ```
   Note: pass `cwd: s.cwd` so project-level `settings.json` is honoured per session — the user-level result is cached, the cheap project-file read can be done per call without measurable cost.
3. New replay map `agentHandshakeBySession` populated alongside `slashInventoryBySession`. The `onOpen` hub-reconnect loop (line 211-214) gains a second loop that emits `agent_handshake` for every entry, mirroring the slash_inventory replay.

### Hub

`packages/hub/src/router.ts` mirrors slash_inventory exactly:

- Extend `DaemonState` (line 22-38) with `agentHandshake: Map<string, Omit<DaemonAgentHandshake, "type"|"session_id">>` (storing the metadata sans envelope keeps the cache slim).
- New `case "agent_handshake":` in `onDaemonFrame` (next to line 265). Cache then broadcast as `PwaAgentHandshake` with `daemon_id` injected.
- `onPwaSubscribe` (line 329-343) gains a second loop replaying cached handshakes.
- `onDaemonDisconnect` clears the map. `session_close` deletes the per-session entry alongside `slashInventory.delete`.

### PWA

`packages/pwa/src/hooks/useHub.ts`:

- Extend `HubState` (line 115-121) with `agentHandshakes: Record<string, AgentHandshakePayload>` keyed by `eventKey(daemon_id, session_id)` (same shape as `slashInventory`).
- Init in `initialHubState()` (line 127-138).
- New reducer case in the message dispatch (next to line 545):
  ```ts
  case "agent_handshake": {
    const k = eventKey(frame.daemon_id, frame.session_id);
    return {
      ...prev,
      agentHandshakes: { ...prev.agentHandshakes, [k]: frame },
      // Mirror to slashInventory so legacy SlashMenu callers keep working
      // even if some component hasn't migrated yet.
      slashInventory: { ...prev.slashInventory, [k]: frame.available_commands },
    };
  }
  ```

`packages/pwa/src/hooks/useAgentCapabilities.ts` (new):

```ts
export function selectAgentCapabilities(
  state: Pick<HubState, "agentHandshakes">,
  daemon_id: string,
  session_id: string,
): PwaAgentHandshake | null {
  return state.agentHandshakes[eventKey(daemon_id, session_id)] ?? null;
}
```

Selector pattern matches `useSlashInventory.ts` — pure function, no React hook layer.

`SettingsDrawer.tsx` adds a read-only "Agent" section (between Notifications and the Daemons list, around line 95-133): version, mode list with the default highlighted, model alias list, capability badges (✓/✗ for each capability bit). When no daemon is selected or no handshake yet → render a single "—" placeholder; do not render a spinner (frame is push-based; absence of frame for >5s reliably means "old daemon" or "no live session").

`SessionView.tsx` SlashMenu wiring (line 109): replace `slashEntries` prop's source with `selectAgentCapabilities(state, daemon_id, session_id)?.available_commands ?? selectSlashInventory(state, daemon_id, session_id)`. Two-line change.

## File-by-file changes

| File | Change |
|---|---|
| `packages/daemon/src/agent-probe.ts` | New. Exports `probeAgent` + `clearProbeCacheForTests`. ~120 lines incl. semver helper. |
| `packages/proto/src/frames.ts` | Add `AgentCapabilityBits`, `DaemonAgentHandshake`, `PwaAgentHandshake`. Extend `DaemonToHub` + `HubToPwa` unions. Add deprecation comment to `*SlashInventory`. |
| `packages/proto/src/index.ts` | Re-export the three new types. |
| `packages/daemon/src/index.ts` | New `agentHandshakeBySession` map (~line 180). `onOpen` replay loop (~line 213) gains second loop. `sessions.onAdd` (~line 643) awaits probe and emits frame. |
| `packages/hub/src/router.ts` | Extend `DaemonState` (line 38). New `agent_handshake` case (~line 265). `onPwaSubscribe` replay loop (~line 333). `onDaemonDisconnect` / `session_close` clear. |
| `packages/pwa/src/hooks/useHub.ts` | `HubState.agentHandshakes` field + initial state + reducer case (~line 545). |
| `packages/pwa/src/hooks/useAgentCapabilities.ts` | New selector (~15 lines, mirrors `useSlashInventory.ts`). |
| `packages/pwa/src/screens/SettingsDrawer.tsx` | New "Agent" section (~50 lines). |
| `packages/pwa/src/screens/SessionView.tsx` | Two-line SlashMenu source switch with fallback. |
| `packages/daemon/tests/agent-probe.test.ts` | New. |
| `packages/proto/tests/frames.test.ts` | Add round-trip test for `agent_handshake` (mirror line 306-322 slash_inventory test). |

Net: ~400 lines added across 11 files. No deletions.

## Out of scope

- **Switching mode / model from PWA** — observe-only philosophy; switching happens in the TUI (`/model`, `/permission-mode`).
- **Live capability re-probe** — restart the daemon after CC auto-update.
- **Per-session different agents** — claude-only, single global probe.
- **Deletion of `slash_inventory`** — kept for migration; cleanup is a separate spec.
- **ACP migration** — declined in `docs/research/aionui-comparison.md` §7.
- **Static model list** — CC does not expose one; revisit when/if a `--list-models` flag ships.

## Testing strategy

`packages/daemon/tests/agent-probe.test.ts`:

- Inject a fake `Bun.spawn` via the `spawn` option. Cases:
  1. Healthy `--help` + `--version` → parsed modes match exactly, version-gated bits correct (e.g. version `2.1.150` → `supports_ack: true`, `supports_notification_hook: true`, `jsonl_flush_quirk: true`).
  2. `--version` exit 1 → `agent_version: null`, all version-gated bits `false`.
  3. `--help` output missing the choices block → fallback hardcoded list.
  4. `~/.claude/settings.json` missing → `default_mode: null`.
  5. Project `settings.json` overrides user.
  6. Project file with malformed JSON → fall back to user, log warning.
- Concurrency: two simultaneous `probeAgent()` calls share one spawn (cache hits).

`packages/proto/tests/frames.test.ts`: add round-trip JSON test mirroring the existing slash_inventory test at line 306-322.

`packages/hub/tests/router.test.ts` (or wherever the slash_inventory router test lives): assert daemon `agent_handshake` is broadcast to PWAs with `daemon_id` injected; assert it is replayed on `onPwaSubscribe`; assert clearing on `session_close` and `onDaemonDisconnect`.

`packages/pwa/src/hooks/useHub.test.ts` (or co-located): reducer test — feed `agent_handshake` frame, assert state shape, assert `slashInventory` mirror update.

`e2e-real`: extend an existing scenario (e.g. `13-slash-inventory.test.ts` if present, or `12-chat-roundtrip.test.ts`) — assert the PWA receives `agent_handshake` within 2s of subscribe, with non-empty `available_modes` (since the test image has `claude` installed).

## Migration / compatibility

- **New PWA + old daemon**: no `agent_handshake` frame. PWA's `selectAgentCapabilities` returns `null`; SessionView falls back to `selectSlashInventory`; SettingsDrawer Agent section renders "—". No regression.
- **New daemon + old PWA**: PWA reducer receives an unknown `type`, hits the `default` branch, drops the frame. Legacy `slash_inventory` still flows. No regression.
- **Hub upgrade ordering**: hub forwards by union case — old hub silently drops the frame; deploy hub before either daemon or PWA upgrade if you want capabilities visible.

→ No deployment ordering constraint required. New PWA on old hub silently degrades to legacy slash inventory.

## Acceptance criteria

1. After PWA subscribe, an `agent_handshake` frame arrives within 2s for each known session in the snapshot. Verify with browser devtools WS inspector.
2. `SettingsDrawer` Agent section displays `2.1.165 (Claude Code)` (or current installed version), the 6 modes from `--help` with `bypassPermissions` (or whatever is in user settings) marked default, and three model aliases.
3. Kill daemon → reconnect → handshake replayed for all live sessions (no empty SettingsDrawer).
4. Rename `claude` binary on the test host → start a new session → handshake still emits with `agent_version: null` and warning in daemon stderr; SettingsDrawer Agent section renders the degraded state without crashing.
5. SlashMenu `/` keeps showing entries (now sourced from handshake) — no regression vs. current behaviour.
6. `grep -E 'agent_handshake|AgentHandshake' packages/{proto,daemon,hub,pwa}/src` returns matches in all four packages.

## Open questions

- **Probe timeout value** — 2s is a guess. If `claude --help` ever exceeds that on a slow disk, the probe falls back unnecessarily. Acceptable initial value; revisit if real-world deploys hit it.
- **Project-level settings.json read on every session** — cheap (one stat + readFile), but if many sessions register concurrently in the same cwd we re-read. If profiling shows it matters, add a `Map<cwd, Promise<…>>` cache. Not worth pre-optimising.
