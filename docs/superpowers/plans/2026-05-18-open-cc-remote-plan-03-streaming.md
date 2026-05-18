# open-cc-remote — Plan 3: Real conversation streaming

> **For agentic workers:** Plan 3 follows Plan 2's compressed format — task list with key interfaces; full code in dispatch prompts at execution time.

**Goal:** When Claude Code writes lines to its session JSONL file, those lines flow daemon → hub → PWA in real time. PWA shows a per-session pane with live event log. No history pagination, no parsing-into-typed-events, no permission relay (Plan 4) — just the streaming spine.

**Architecture:**
- Daemon watches `~/.claude/projects/<encoded>/<session-id>.jsonl` per registered live session, tail-style (current EOF onward, byte-offset tracked in memory only).
- Each new line in the JSONL → `event` frame to hub with raw JSON payload + jsonl_offset.
- Hub Router pipes events to all subscribed PWAs and keeps last-200 ring buffer (already designed in Plan 1, not yet exercised — Plan 3 makes it real).
- PWA gains per-session detail view with live-tailing event list, accessed by clicking a session row.

**Out of scope for Plan 3:**
- Parsing JSONL into typed `assistant_msg` / `tool_call` / etc. — pass raw to PWA, render generically
- request_history / scroll-back / past-session enumeration — Plan 4 or later
- Permission events — Plan 4
- Reconnect gap-fill via ring buffer (the buffer fills; PWA reconnect logic is dumb-resubscribe)

---

## File map (Plan 3 additions)

```
packages/proto/src/frames.ts     ← (modified) add `event` frame
packages/daemon/src/
├── jsonl-watcher.ts             ← NEW: per-session file tailer
├── jsonl-paths.ts               ← NEW: cwd → encoded project dir
├── index.ts                     ← (modified) start watcher on register
packages/hub/src/router.ts       ← (modified) handle event frame
packages/pwa/src/
├── App.tsx                      ← (modified) clickable session rows
├── SessionPane.tsx              ← NEW: live event log
└── ws.ts                        ← (modified) accumulate per-session events
e2e/transcript.test.ts           ← NEW: write JSONL line → see in PWA
```

---

## Tasks

### T1 — Proto: `event` frame

Add to `frames.ts`:

```ts
export interface EventFrame {
  type: "event";
  daemon_id?: string;          // hub→PWA includes; daemon→hub does not
  session_id: string;
  jsonl_offset: number;        // byte offset *after* this line
  ts: number;                  // ms epoch when daemon read it
  payload: unknown;            // raw parsed JSONL line (whatever Claude Code emitted)
}
```

Add to `DaemonToHub` and `HubToPwa` unions. No tests needed (type-only).

### T2 — Daemon: JSONL paths helper

`packages/daemon/src/jsonl-paths.ts`:

```ts
export function encodeCwd(cwd: string): string;        // "/Users/x/y" → "-Users-x-y"
export function jsonlPath(cwd: string, session_id: string): string;  // ~/.claude/projects/<encoded>/<session_id>.jsonl
```

Tests for the encoding (matches Claude Code's known scheme: replace `/` with `-`).

### T3 — Daemon: JSONL watcher

`packages/daemon/src/jsonl-watcher.ts`:

```ts
export interface WatcherOptions {
  path: string;
  startOffset?: number;             // defaults to current EOF
  onLine: (line: string, offset: number) => void;  // offset is *after* line
}
export interface WatcherHandle {
  close(): void;
}
export function startWatcher(opts: WatcherOptions): WatcherHandle;
```

Uses `fs.watch` + manual byte-offset read of new content. Robust against partial-line writes (only emit on `\n`-terminated lines). Tests: append-line round-trip; no spurious emits when file unchanged; handles >1KB writes.

### T4 — Daemon: hook watcher into session lifecycle

Modify `packages/daemon/src/index.ts`. On plugin register:
- Compute JSONL path from `session.cwd` + `session.session_id`
- Start a watcher; pipe each line into a hub `event` frame with the registered session_id
- Track watchers in a `Map<session_id, WatcherHandle>`; close on session bye

Test: integration where index.ts is exercised + a JSONL file appended to → verify hub receives event frames. Or rely on Plan 3 e2e for this.

### T5 — Hub: Router handles event frames

Modify `packages/hub/src/router.ts`:
- New `case "event"` in `onDaemonFrame` — broadcast to PWAs as `{type: "event", daemon_id, ...}`
- Maintain per-daemon ring buffer (already conceptualized in Plan 1; now actually populate it)
- New PwaToHub frame: none yet (Plan 3 PWA is read-only)

Tests: existing router tests + 2 new (event frame fanout, ring buffer caps at 200).

### T6 — PWA: per-session pane

`packages/pwa/src/SessionPane.tsx` — receives `events: EventFrame[]` and renders a scrollable list. Each event shows: `<small>ts</small> <pre>JSON.stringify(payload, null, 2)</pre>`. Auto-scroll to bottom unless user scrolled up.

Modify `App.tsx` to track `selectedSession?: { daemon_id, session_id }`. Clicking a session row opens the pane in a side panel (or below). "Close" button clears selection.

Modify `ws.ts` to accumulate events per `daemon_id:session_id` key. On `event` frame: append to that bucket (cap at 500 in PWA memory).

### T7 — e2e test

`e2e/transcript.test.ts`:
1. Spawn hub (auth disabled), daemon, fake-claude with --session-id `s_e2e_t` --cwd `<tmp>`
2. Write a line to the JSONL Claude Code would write: `<HOME>/.claude/projects/<encoded-tmp>/s_e2e_t.jsonl`
3. Connect PWA WSS, subscribe
4. Assert event frame for `s_e2e_t` with our payload arrives within 2s

The test fakes both the plugin (via fake-claude's register) AND the JSONL append (writing to the file daemon will tail).

### T8 — README + tag

Quickstart updated with: "Real Claude sessions started in tmux now stream their JSONL events to the PWA. Click a daemon's session row to open its live event log."

Tag `plan-03-streaming`.

---

## Self-Review

**Spec coverage** (against Section 7 of design spec):
- §7.2 daemon reads JSONL incrementally — T3 ✓
- §7.6 daemon→hub event frame uses jsonl_offset — T1, T3 ✓
- §3.4 ring buffer in hub — T5 ✓
- §6 transcript view in PWA — T6 ✓
- request_history / list_past_sessions / file uploads — explicitly deferred

**Type consistency:** `EventFrame.payload: unknown` keeps daemon ignorant of Claude Code's evolving JSONL schema. PWA renders generically. Future plans can layer typed kinds without changing this contract.
