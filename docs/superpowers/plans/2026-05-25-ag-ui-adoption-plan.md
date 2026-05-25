# AG-UI Adoption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate daemon→hub→PWA "session events" wire format from raw JSONL payloads to AG-UI events (`@ag-ui/core@0.0.53`), and retire the project-internal `TimelineEvent` discriminated union so PWA cards consume `AGUIEvent[]` directly. Keep all control-class frames untouched.

**Architecture:** daemon runs `ClaudeCodeAdapter.fromClaudeCode(row)` on every JSONL line — both live (jsonl-watcher → hub) and on history retrieval (jsonl-history). `EventFrame.payload` and `HistoryEvent.payload` become `AGUIEvent[]` (one frame = one row = N events). Daemon's session FSM emits `RUN_STARTED/FINISHED/ERROR` at state edges. PWA `useHub` reducer flattens the array on insert; `mergeTimeline` operates on a flat `AGUIEvent[]` keyed by `(jsonl_offset, event_index)`. Permissions and chat continue on existing control-class frames untouched.

**Tech Stack:** `bun` workspace, `@ag-ui/core@0.0.53` (type-only), TypeScript strict mode, `bun:test`, React 18 PWA, WebSocket transport.

**Spec:** `docs/superpowers/specs/2026-05-25-ag-ui-design.md` — read it before starting any task.

---

## File Map

| Layer | Action | Path | Responsibility |
|---|---|---|---|
| proto | modify | `packages/proto/src/agui/events.ts` | Re-export `@ag-ui/core` types; remove `CcRemoteCustomNames` |
| proto | modify | `packages/proto/src/agui/from-claude-code.ts` | JSONL row → `AGUIEvent[]`; no CUSTOM, no THINKING_*, sets `rawEvent.is_error` on TOOL_CALL_RESULT |
| proto | DELETE | `packages/proto/src/agui/to-timeline.ts` | (no longer needed) |
| proto | modify | `packages/proto/src/agui/index.ts` | Re-export from `events.ts` and `from-claude-code.ts` only |
| proto | modify | `packages/proto/src/frames.ts` | `EventFrame.payload: AGUIEvent[]`; `HistoryEvent.payload: AGUIEvent[]` |
| proto | modify | `packages/proto/src/index.ts` | Re-export AG-UI types from `agui/` |
| proto | DELETE | `packages/proto/tests/agui/round-trip.test.ts` | (replaced) |
| proto | create | `packages/proto/tests/agui/from-claude-code.test.ts` | Asserts shape, no CUSTOM, no THINKING_*, is_error contract |
| daemon | create | `packages/daemon/src/adapters/index.ts` | `AgentAdapter` interface |
| daemon | create | `packages/daemon/src/adapters/claude-code.ts` | `ClaudeCodeAdapter` wrapping `fromClaudeCode` |
| daemon | create | `packages/daemon/tests/adapters.test.ts` | Adapter contract tests |
| daemon | modify | `packages/daemon/src/index.ts:285-293` | Use adapter in jsonl onLine; emit `AGUIEvent[]` |
| daemon | modify | `packages/daemon/src/jsonl-history.ts` | Run adapter; return `AGUIEvent[]` |
| daemon | modify | `packages/daemon/tests/jsonl-history.test.ts` | Update for new payload shape |
| daemon | modify | `packages/daemon/src/session-fsm.ts` | Emit `RUN_*` events on transitions |
| daemon | modify | `packages/daemon/tests/session-fsm.test.ts` | Cover RUN_* emissions |
| hub | verify | `packages/hub/src/router.ts` | Transparent forwarder; no logic change expected |
| pwa | modify | `packages/pwa/src/hooks/useHub.ts` | Reducer flattens `payload[]` into buffer entries keyed by `(jsonl_offset, event_index)` |
| pwa | create | `packages/pwa/src/lib/view-helpers.ts` | `toolStatusFromResult`, `formatDuration`, `riskFromToolName` |
| pwa | modify | `packages/pwa/src/lib/timeline.ts` | `mergeTimeline` consumes `AGUIEvent[]`; emits a render-list, no `TimelineEvent` indirection |
| pwa | modify | `packages/pwa/src/screens/timeline/types.ts` | Replace `TimelineEvent` with `RenderItem` (thin shape over AGUIEvent + control items) |
| pwa | modify | `packages/pwa/src/screens/timeline/renderTimelineItem.tsx` | Dispatch on AGUIEvent type, not `kind` |
| pwa | modify | `packages/pwa/src/screens/timeline/cards/AssistantBubble.tsx` | `*Live` consumes a `TextMessageChunkEvent` |
| pwa | modify | `packages/pwa/src/screens/timeline/cards/UserBubble.tsx` | Same |
| pwa | DELETE | `packages/pwa/src/screens/timeline/cards/TaskCreatedCard.tsx` | demo-only, never used in live path |
| pwa | DELETE | `packages/pwa/src/screens/timeline/cards/TaskCompletedCard.tsx` | demo-only |
| pwa | DELETE | `packages/pwa/src/screens/timeline/cards/IdleWaitingCard.tsx` | demo-only |
| pwa | modify | `packages/pwa/src/screens/timeline/cards/index.ts` | Remove the 3 deleted exports |
| pwa | modify | `packages/pwa/src/demo/DemoApp.tsx` | Drop the 3 imports + 3 usages + `kind:"task"` mock data |
| pwa | modify | `packages/pwa/src/hooks/useSessionTimeline.ts` | Updated signature for new `mergeTimeline` |
| e2e | verify | `e2e-real/tests/*.test.ts` | Run; fix any breakage caused by wire-format change |

---

## Dependency Graph

```
Phase A (proto types) ────┬──▶ Phase B (daemon)
                          ├──▶ Phase C (hub verify)
                          └──▶ Phase D (PWA)
                                       │
                                       ▼
                                  Phase E (e2e)
```

Phase A blocks B/C/D. After A merges, B+C+D can be dispatched to subagents in parallel.

---

## Phase A — proto (sequential single subagent: same files)

### Task A1: Strip CUSTOM, enforce is_error + REASONING contracts in adapter

**Files:**
- Modify: `packages/proto/src/agui/events.ts`
- Modify: `packages/proto/src/agui/from-claude-code.ts`
- Create: `packages/proto/tests/agui/from-claude-code.test.ts`
- DELETE: `packages/proto/tests/agui/round-trip.test.ts` (replaced)
- DELETE: `packages/proto/src/agui/to-timeline.ts` (no consumer after PWA migration)

- [ ] **Step 1: Write the failing contract test**

Create `packages/proto/tests/agui/from-claude-code.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EventType } from "@ag-ui/core";
import { fromClaudeCode } from "../../src/agui/from-claude-code";

const TAPES_DIR = join(import.meta.dir, "../../../../e2e-real/fixtures/jsonl-tapes");
const TAPES = [
  "bash-failure.jsonl",
  "bash-success.jsonl",
  "channel-injection.jsonl",
  "long-output.jsonl",
  "read-then-edit.jsonl",
  "thinking-then-tool.jsonl",
];

function parseTape(name: string): unknown[] {
  const text = readFileSync(join(TAPES_DIR, name), "utf8");
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const ctx = { threadId: "t1", runId: "r1" };

describe("fromClaudeCode contract", () => {
  test("never emits CUSTOM events (decision #10)", () => {
    for (const tape of TAPES) {
      for (const row of parseTape(tape)) {
        for (const ev of fromClaudeCode(row, ctx)) {
          expect(ev.type).not.toBe(EventType.CUSTOM);
        }
      }
    }
  });

  test("never emits THINKING_* events (decision #8)", () => {
    const banned = new Set([
      EventType.THINKING_START,
      EventType.THINKING_END,
      EventType.THINKING_TEXT_MESSAGE_START,
      EventType.THINKING_TEXT_MESSAGE_CONTENT,
      EventType.THINKING_TEXT_MESSAGE_END,
    ]);
    for (const tape of TAPES) {
      for (const row of parseTape(tape)) {
        for (const ev of fromClaudeCode(row, ctx)) {
          expect(banned.has(ev.type)).toBe(false);
        }
      }
    }
  });

  test("never emits RUN_STARTED/FINISHED/ERROR (decision #5 — daemon FSM does that)", () => {
    const banned = new Set([EventType.RUN_STARTED, EventType.RUN_FINISHED, EventType.RUN_ERROR]);
    for (const tape of TAPES) {
      for (const row of parseTape(tape)) {
        for (const ev of fromClaudeCode(row, ctx)) {
          expect(banned.has(ev.type)).toBe(false);
        }
      }
    }
  });

  test("TOOL_CALL_RESULT carries rawEvent.is_error (decision #7)", () => {
    // bash-failure.jsonl includes a tool_result with is_error=true.
    const events = parseTape("bash-failure.jsonl").flatMap((row) => fromClaudeCode(row, ctx));
    const results = events.filter((e) => e.type === EventType.TOOL_CALL_RESULT);
    expect(results.length).toBeGreaterThan(0);
    for (const ev of results) {
      const raw = (ev as { rawEvent?: { is_error?: unknown } }).rawEvent;
      expect(raw).toBeDefined();
      expect(typeof raw?.is_error).toBe("boolean");
    }
    expect(results.some((e) => (e as { rawEvent: { is_error: boolean } }).rawEvent.is_error === true)).toBe(true);
  });

  test("multi-block rows produce N events sharing the row's logical offset", () => {
    // thinking-then-tool.jsonl has rows with reasoning + tool_use in a single line.
    const rows = parseTape("thinking-then-tool.jsonl");
    const multiBlockRow = rows.find((row) => {
      const blocks = (row as { message?: { content?: unknown[] } }).message?.content;
      return Array.isArray(blocks) && blocks.length >= 2;
    });
    expect(multiBlockRow).toBeDefined();
    const events = fromClaudeCode(multiBlockRow, ctx);
    expect(events.length).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run the test — expect FAIL**

```bash
bun test packages/proto/tests/agui/from-claude-code.test.ts
```

Expected: at minimum, "never emits CUSTOM" fails because spike emits `CUSTOM cc-remote.compact` for `summary` rows.

- [ ] **Step 3: Strip CUSTOM types from `events.ts`**

Edit `packages/proto/src/agui/events.ts`. Remove the `CcRemoteCustomNames` namespace and any related type aliases. The file should now contain only:

```typescript
/**
 * AG-UI event types — re-exports from @ag-ui/core@0.0.53.
 *
 * v1 of the cc-remote protocol uses NO CUSTOM events (decision #10 of
 * docs/superpowers/specs/2026-05-25-ag-ui-design.md). Anything not
 * expressible as a standard AG-UI event falls through to RAW.
 *
 * Type-only re-export keeps proto bundle dep-free of zod and
 * @ag-ui/core's runtime schemas.
 */

export {
  EventType,
  type AGUIEvent,
  type RunStartedEvent,
  type RunFinishedEvent,
  type RunErrorEvent,
  type TextMessageChunkEvent,
  type ToolCallChunkEvent,
  type ToolCallResultEvent,
  type ReasoningMessageChunkEvent,
  type ActivitySnapshotEvent,
  type ActivityDeltaEvent,
  type StateDeltaEvent,
  type RawEvent,
} from "@ag-ui/core";
```

- [ ] **Step 4: Strip CUSTOM emitters from `from-claude-code.ts`**

In `packages/proto/src/agui/from-claude-code.ts`:

1. Find the branch that emits `CUSTOM cc-remote.compact` for `summary` rows (around line 270 in the spike). Replace it with a `RAW` emit:

```typescript
// Replace any branch like:
//   if (rowType === "summary") {
//     out.push({ type: EventType.CUSTOM, name: CcRemoteCustomNames.compact, ... });
//   }
// with:
if (rowType === "summary") {
  out.push({
    type: EventType.RAW,
    source: "claude-code-jsonl",
    event: jsonlRow,
    ...(ts !== undefined ? { timestamp: ts } : {}),
  });
  return out;
}
```

2. Delete the entire `permissionInlineCustom(...)` and `permissionResolvedCustom(...)` builder functions (permission frames are control-class, not in AG-UI path — decision #6).

3. Verify the `tool_result` branch retains the `rawEvent: { is_error, ...rest }` payload. If the spike used `_ccIsError`, rename to plain `is_error`:

```typescript
out.push({
  type: EventType.TOOL_CALL_RESULT,
  messageId: `event:${offset}:result:${toolUseId}`,
  toolCallId: toolUseId,
  content: output,
  role: "tool",
  ...(ts !== undefined ? { timestamp: ts } : {}),
  rawEvent: { is_error: isError, source: "claude-code-jsonl", row: jsonlRow },
});
```

4. Remove `RUN_STARTED/FINISHED/ERROR` emissions if any exist in this row mapper (decision #5 — daemon FSM owns these).

- [ ] **Step 5: Delete `to-timeline.ts` and `round-trip.test.ts`**

```bash
rm packages/proto/src/agui/to-timeline.ts
rm packages/proto/tests/agui/round-trip.test.ts
```

- [ ] **Step 6: Update `agui/index.ts` to drop `to-timeline` re-exports**

`packages/proto/src/agui/index.ts`:

```typescript
export * from "./events";
export { fromClaudeCode } from "./from-claude-code";
```

- [ ] **Step 7: Run the contract test — expect PASS**

```bash
bun test packages/proto/tests/agui/from-claude-code.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 8: Run full proto suite + typecheck**

```bash
bun test packages/proto/
bunx tsc --noEmit -p packages/proto
```

Expected: all green; no `TimelineEvent` import errors (the `to-timeline.ts` was the only consumer).

- [ ] **Step 9: Commit**

```bash
git add packages/proto/src/agui/ packages/proto/tests/agui/
git commit -m "feat(proto): AG-UI adapter contracts — no CUSTOM, no THINKING_*, rawEvent.is_error

Promote spike. fromClaudeCode now obeys spec decisions #5/#7/#8/#10:
no RUN_*, no CUSTOM, no THINKING_* emissions; TOOL_CALL_RESULT carries
rawEvent.is_error as the documented success/failure encoding.
to-timeline.ts and round-trip.test.ts retired (no TimelineEvent target
in v1)."
```

---

### Task A2: Wire format types — `EventFrame.payload` and `HistoryEvent.payload` become `AGUIEvent[]`

**Files:**
- Modify: `packages/proto/src/frames.ts`
- Modify: `packages/proto/src/index.ts`

- [ ] **Step 1: Update `frames.ts` types**

In `packages/proto/src/frames.ts`:

```typescript
// Add at top (after existing imports if any):
import type { AGUIEvent } from "./agui/events";
```

Change `EventFrame` (around line 62):

```typescript
export interface EventFrame {
  type: "event";
  session_id: string;
  jsonl_offset: number;     // byte offset *after* this line in the JSONL file
  ts: number;               // ms epoch when daemon read it
  payload: AGUIEvent[];     // post-adapter; one source row → N AG-UI events
}
```

Change `HistoryEvent` (around line 176):

```typescript
export interface HistoryEvent {
  jsonl_offset: number;
  payload: AGUIEvent[];     // post-adapter; one source row → N AG-UI events
}
```

- [ ] **Step 2: Re-export from proto index**

In `packages/proto/src/index.ts`, add:

```typescript
export * from "./agui";
```

- [ ] **Step 3: Run typecheck — expect FAIL across daemon/hub/PWA**

```bash
bunx tsc --noEmit -p packages/proto
```

Expected: proto itself typechecks (its own internals don't read `payload`). Other packages will fail in their own typechecks until later phases — that's expected and not blocking for this task.

- [ ] **Step 4: Commit**

```bash
git add packages/proto/src/frames.ts packages/proto/src/index.ts
git commit -m "feat(proto): wire format — EventFrame.payload and HistoryEvent.payload are AGUIEvent[]

Decision #3: one frame = one JSONL row = N AG-UI events. The PWA reducer
flattens on insert; dedup remains keyed by jsonl_offset.
Decision #3b: HistoryEvent.payload is also AGUIEvent[] so live and
history share one conversion site (daemon)."
```

---

## Phase B — daemon (sequential single subagent)

**Prerequisite:** Phase A merged.

### Task B1: `AgentAdapter` interface + `ClaudeCodeAdapter`

**Files:**
- Create: `packages/daemon/src/adapters/index.ts`
- Create: `packages/daemon/src/adapters/claude-code.ts`
- Create: `packages/daemon/tests/adapters.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/daemon/tests/adapters.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { EventType } from "@cc-remote/proto";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code";

describe("ClaudeCodeAdapter", () => {
  test("convertRow returns AGUIEvent[] for a tool_result row with is_error", () => {
    const adapter = new ClaudeCodeAdapter();
    const row = {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "err", is_error: true },
        ],
      },
    };
    const events = adapter.convertRow(row, { sessionId: "s1", jsonlOffset: 100 });
    expect(events.length).toBeGreaterThan(0);
    const result = events.find((e) => e.type === EventType.TOOL_CALL_RESULT);
    expect(result).toBeDefined();
    const raw = (result as { rawEvent: { is_error: boolean } }).rawEvent;
    expect(raw.is_error).toBe(true);
  });

  test("convertRow returns [] for a malformed row without throwing", () => {
    const adapter = new ClaudeCodeAdapter();
    expect(() => adapter.convertRow(null, { sessionId: "s1", jsonlOffset: 0 })).not.toThrow();
    expect(adapter.convertRow(null, { sessionId: "s1", jsonlOffset: 0 })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL ("Cannot find module")**

```bash
bun test packages/daemon/tests/adapters.test.ts
```

- [ ] **Step 3: Create the interface**

`packages/daemon/src/adapters/index.ts`:

```typescript
import type { AGUIEvent } from "@cc-remote/proto";

export interface ConvertContext {
  /** Internal session id (daemon's, not Claude's). */
  sessionId: string;
  /** Byte offset *after* the source row, used for AG-UI event ids. */
  jsonlOffset: number;
}

export interface AgentAdapter {
  /** Map one parsed source-format row to zero or more AG-UI events.
   *  Must NOT emit RUN_STARTED/FINISHED/ERROR — those are FSM-driven. */
  convertRow(row: unknown, ctx: ConvertContext): AGUIEvent[];
}
```

- [ ] **Step 4: Create the Claude implementation**

`packages/daemon/src/adapters/claude-code.ts`:

```typescript
import type { AGUIEvent } from "@cc-remote/proto";
import { fromClaudeCode } from "@cc-remote/proto";
import type { AgentAdapter, ConvertContext } from "./index";

export class ClaudeCodeAdapter implements AgentAdapter {
  convertRow(row: unknown, ctx: ConvertContext): AGUIEvent[] {
    if (row === null || row === undefined) return [];
    return fromClaudeCode(row, {
      threadId: ctx.sessionId,
      runId: `${ctx.sessionId}:${ctx.jsonlOffset}`,
    });
  }
}
```

- [ ] **Step 5: Run — expect PASS**

```bash
bun test packages/daemon/tests/adapters.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/src/adapters/ packages/daemon/tests/adapters.test.ts
git commit -m "feat(daemon): AgentAdapter interface + ClaudeCodeAdapter

First adapter implementation — wraps fromClaudeCode and exposes a
convertRow(row, ctx) → AGUIEvent[] surface. Future CodexAdapter will
implement the same interface against codex exec --json."
```

---

### Task B2: Wire jsonl-bind onLine through the adapter (live path)

**Files:**
- Modify: `packages/daemon/src/index.ts:285-293` (the `onLine` callback that builds `EventFrame`)

- [ ] **Step 1: Read existing tests so you don't break them**

```bash
bun test packages/daemon/tests/jsonl-watcher.test.ts
```

Expected: passes against current shape.

- [ ] **Step 2: Update the onLine callback in `packages/daemon/src/index.ts`**

Find the block around line 284-293 (the `startWatcher({ ... onLine: ... })` call inside the `bindJsonl` then-block). Replace:

```typescript
onLine: (line, jsonl_offset) => {
  let payload: unknown;
  try { payload = JSON.parse(line); } catch { payload = { raw: line }; }
  hub.send({
    type: "event",
    session_id: s.session_id,
    jsonl_offset,
    ts: Date.now(),
    payload,
  });
  // ... fsm.onJsonlLine + idle-timer logic stays
}
```

with:

```typescript
onLine: (line, jsonl_offset) => {
  let row: unknown;
  try { row = JSON.parse(line); } catch { row = { raw: line }; }
  const payload = adapter.convertRow(row, {
    sessionId: s.session_id,
    jsonlOffset: jsonl_offset,
  });
  hub.send({
    type: "event",
    session_id: s.session_id,
    jsonl_offset,
    ts: Date.now(),
    payload,
  });

  // Drive FSM with the row (FSM still works on JSONL semantics)
  fsm.onJsonlLine(s.session_id);
  // ... idle-timer logic against `row` instead of the removed `payload` var
  const p = row as { type?: string; message?: { stop_reason?: string } };
  // ... rest of the existing idle-timer block; replace any reference
  //     to the old `payload` variable with `row`.
}
```

Also, near the top of `index.ts` (with other imports), add:

```typescript
import { ClaudeCodeAdapter } from "./adapters/claude-code";
```

And in the daemon bootstrap (just before `startWatcher` is called, e.g. inside the registration handler), instantiate:

```typescript
const adapter = new ClaudeCodeAdapter();
```

(If there is already a sensible scope-level place to construct it — e.g., a long-lived daemon-level instance — instantiate once at module init instead of per-session.)

- [ ] **Step 3: Run all daemon tests**

```bash
bun test packages/daemon/
```

Expected: existing tests for jsonl-watcher, jsonl-history, etc. continue to pass. Any test that asserts on `EventFrame.payload`'s old shape (raw JSONL) will fail — those need updates in their own tasks (B3 covers history; if other tests fail, update them inline here).

- [ ] **Step 4: Typecheck**

```bash
bunx tsc --noEmit -p packages/daemon
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/index.ts
git commit -m "feat(daemon): jsonl-bind emits AGUIEvent[] via ClaudeCodeAdapter

EventFrame.payload is now adapter output, not raw JSONL. Idle timer
still inspects row.type / row.message.stop_reason from the parsed row
before adapter conversion."
```

---

### Task B3: Wire jsonl-history through the adapter

**Files:**
- Modify: `packages/daemon/src/jsonl-history.ts`
- Modify: `packages/daemon/tests/jsonl-history.test.ts`

- [ ] **Step 1: Update test expectations first**

In `packages/daemon/tests/jsonl-history.test.ts`, find any assertion on `event.payload` shape and update to expect an array. Example (adjust to match the actual test):

```typescript
// before:
expect(events[0].payload).toEqual({ type: "user", ... });
// after:
expect(Array.isArray(events[0].payload)).toBe(true);
expect(events[0].payload.length).toBeGreaterThan(0);
```

If the test currently asserts specific raw shape, replace with a lighter assertion that the payload is `AGUIEvent[]` and at least one event has a recognizable `type`.

- [ ] **Step 2: Run — expect FAIL**

```bash
bun test packages/daemon/tests/jsonl-history.test.ts
```

- [ ] **Step 3: Update `jsonl-history.ts`**

```typescript
import { existsSync, readFileSync } from "node:fs";
import type { AGUIEvent } from "@cc-remote/proto";
import { ClaudeCodeAdapter } from "./adapters/claude-code";

const adapter = new ClaudeCodeAdapter();

export interface HistoryEvent {
  jsonl_offset: number;
  payload: AGUIEvent[];
}

export async function readHistory(
  path: string,
  before_offset: number,
  limit: number,
  sessionId: string,
): Promise<HistoryEvent[]> {
  if (!existsSync(path)) return [];
  if (before_offset <= 0 || limit <= 0) return [];

  const content = readFileSync(path, "utf8");
  let pos = 0;
  const all: HistoryEvent[] = [];

  while (pos < content.length) {
    const nl = content.indexOf("\n", pos);
    if (nl === -1) break;
    const line = content.slice(pos, nl);
    const lineEndOffset = Buffer.byteLength(content.slice(0, nl + 1), "utf8");
    if (lineEndOffset > before_offset) break;
    let row: unknown;
    try { row = JSON.parse(line); } catch { row = { raw: line }; }
    const payload = adapter.convertRow(row, {
      sessionId,
      jsonlOffset: lineEndOffset,
    });
    all.push({ jsonl_offset: lineEndOffset, payload });
    pos = nl + 1;
  }

  return all.slice(-limit);
}
```

- [ ] **Step 4: Update callers of `readHistory` to pass `sessionId`**

```bash
grep -rn "readHistory(" packages/daemon/src/
```

Update each call site to pass the session id (you'll find them in `index.ts` near the history request handler). Adjust the test in step 1 accordingly to pass a session id.

- [ ] **Step 5: Run — expect PASS**

```bash
bun test packages/daemon/tests/jsonl-history.test.ts
bun test packages/daemon/
```

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/src/jsonl-history.ts packages/daemon/src/index.ts packages/daemon/tests/jsonl-history.test.ts
git commit -m "feat(daemon): jsonl-history uses adapter; HistoryEvent.payload is AGUIEvent[]

Decision #3b: live and history share the same daemon-side conversion
site so the PWA never sees raw JSONL."
```

---

### Task B4: Session FSM emits `RUN_STARTED/FINISHED/ERROR`

**Files:**
- Modify: `packages/daemon/src/session-fsm.ts`
- Modify: `packages/daemon/tests/session-fsm.test.ts`
- Modify: `packages/daemon/src/index.ts` (wire the FSM listener to emit AG-UI run events into the `EventFrame.payload` stream)

- [ ] **Step 1: Write the failing FSM test**

Add to `packages/daemon/tests/session-fsm.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { EventType, type AGUIEvent } from "@cc-remote/proto";
import { SessionFsm } from "../src/session-fsm";

describe("SessionFsm RUN_* emissions", () => {
  test("emits RUN_STARTED on first onJsonlLine after register", () => {
    const fsm = new SessionFsm();
    const events: AGUIEvent[] = [];
    fsm.onRunEvent((_, ev) => events.push(ev));
    fsm.register("s1");
    fsm.onJsonlLine("s1");
    const started = events.find((e) => e.type === EventType.RUN_STARTED);
    expect(started).toBeDefined();
    expect((started as { threadId: string }).threadId).toBe("s1");
  });

  test("emits RUN_FINISHED on idle timer fire", () => {
    const fsm = new SessionFsm();
    const events: AGUIEvent[] = [];
    fsm.onRunEvent((_, ev) => events.push(ev));
    fsm.register("s1");
    fsm.onJsonlLine("s1");          // idle → working, emits RUN_STARTED
    fsm.onIdleTimer("s1");          // working → idle, emits RUN_FINISHED
    expect(events.find((e) => e.type === EventType.RUN_FINISHED)).toBeDefined();
  });

  test("emits RUN_ERROR via onError API", () => {
    const fsm = new SessionFsm();
    const events: AGUIEvent[] = [];
    fsm.onRunEvent((_, ev) => events.push(ev));
    fsm.register("s1");
    fsm.onError("s1", { message: "spawn failed" });
    expect(events.find((e) => e.type === EventType.RUN_ERROR)).toBeDefined();
  });

  test("does NOT emit RUN_STARTED on permission-only activity (waiting state)", () => {
    const fsm = new SessionFsm();
    const events: AGUIEvent[] = [];
    fsm.onRunEvent((_, ev) => events.push(ev));
    fsm.register("s1");
    fsm.onPermissionRequest("s1");
    expect(events.filter((e) => e.type === EventType.RUN_STARTED).length).toBe(0);
  });
});
```

- [ ] **Step 2: Run — expect FAIL ("onRunEvent is not a function")**

```bash
bun test packages/daemon/tests/session-fsm.test.ts
```

- [ ] **Step 3: Add RUN_* emission to FSM**

Edit `packages/daemon/src/session-fsm.ts`:

```typescript
import type { SessionState, AGUIEvent } from "@cc-remote/proto";
import { EventType } from "@cc-remote/proto";

// ... existing class top + interfaces ...

export class SessionFsm {
  // ... existing private state ...

  private runListeners: ((session_id: string, ev: AGUIEvent) => void)[] = [];

  onRunEvent(l: (session_id: string, ev: AGUIEvent) => void): void {
    this.runListeners.push(l);
  }

  private fireRun(session_id: string, ev: AGUIEvent): void {
    for (const l of this.runListeners) l(session_id, ev);
  }

  // Modify the existing transition emit point so that:
  //   - on prev=idle && next=working      → emit RUN_STARTED
  //   - on prev=working && next=idle      → emit RUN_FINISHED
  // Insert these calls inside the existing transition logic, NOT as
  // a wholesale rewrite. Look for where `listeners` are notified after
  // a state change and add fireRun next to it.

  // Add an explicit error API that the daemon calls on spawn-fail:
  onError(session_id: string, opts: { message: string; code?: string }): void {
    this.fireRun(session_id, {
      type: EventType.RUN_ERROR,
      message: opts.message,
      ...(opts.code ? { code: opts.code } : {}),
    });
  }
}
```

For the working↔idle transitions, insert RUN_STARTED / RUN_FINISHED emissions where the existing `listeners` notification happens. Inspect the existing code first; do not duplicate the transition detection logic.

Specifically: the `onJsonlLine`, `onIdleTimer`, `onPermissionRequest`, `onPermissionResolved` methods in the existing FSM compute `prev` and `next` states. Right after `notifyListeners(session_id, next, prev)` (or whatever the actual call is), add:

```typescript
if (prev === "idle" && next === "working") {
  this.fireRun(session_id, {
    type: EventType.RUN_STARTED,
    threadId: session_id,
    runId: `${session_id}:${Date.now()}`,
  });
} else if (prev === "working" && next === "idle") {
  this.fireRun(session_id, {
    type: EventType.RUN_FINISHED,
    threadId: session_id,
    runId: `${session_id}:${Date.now()}`,
  });
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
bun test packages/daemon/tests/session-fsm.test.ts
```

- [ ] **Step 5: Wire the listener in `daemon/src/index.ts` to send RUN_* events to hub**

Find where the FSM is instantiated in `index.ts`. Add:

```typescript
fsm.onRunEvent((session_id, ev) => {
  hub.send({
    type: "event",
    session_id,
    jsonl_offset: -1,        // -1 marker: synthetic FSM event, no JSONL row
    ts: Date.now(),
    payload: [ev],
  });
});
```

The `-1` jsonl_offset tells the PWA reducer "this didn't come from JSONL; don't dedup against any real offset". Use the `(jsonl_offset, event_index)` flatten key — `(-1, 0..N)` will collide if you fire many RUN_* events with the same ts; ensure the reducer's flatten step uses a synthetic strictly-increasing fallback for `jsonl_offset === -1`.

A simpler path: assign each FSM emission a unique decreasing pseudo-offset (e.g., `-(Date.now())`) so they never collide and never overlap with real positive offsets. Use that approach:

```typescript
fsm.onRunEvent((session_id, ev) => {
  hub.send({
    type: "event",
    session_id,
    jsonl_offset: -Date.now(),
    ts: Date.now(),
    payload: [ev],
  });
});
```

- [ ] **Step 6: Run all daemon tests**

```bash
bun test packages/daemon/
```

- [ ] **Step 7: Commit**

```bash
git add packages/daemon/src/session-fsm.ts packages/daemon/tests/session-fsm.test.ts packages/daemon/src/index.ts
git commit -m "feat(daemon): FSM emits RUN_STARTED/RUN_FINISHED/RUN_ERROR

Per decision #5, run-lifecycle events are FSM-driven, not row-mapper-
driven. Daemon forwards FSM emissions as synthetic EventFrames with
negative jsonl_offset so they never collide with real JSONL offsets in
the PWA reducer."
```

---

## Phase C — hub (verification only)

### Task C1: Verify hub forwards new EventFrame transparently

**Files:**
- Verify: `packages/hub/src/router.ts`
- Run: hub test suite

- [ ] **Step 1: Inspect the router event-forward path**

```bash
grep -n "EventFrame\|payload" packages/hub/src/router.ts | head -20
```

The hub should be forwarding `EventFrame` opaquely to PWAs (adding `daemon_id`). Confirm there's no logic that inspects `payload`'s shape.

- [ ] **Step 2: Run hub tests**

```bash
bun test packages/hub/
```

Expected: all green. If any test fails because it asserts on `payload` shape, update the assertion to expect an array (similar to Task B3 step 1).

- [ ] **Step 3: Typecheck**

```bash
bunx tsc --noEmit -p packages/hub
```

- [ ] **Step 4: Commit (only if changes were needed)**

```bash
git add -p packages/hub/
git commit -m "test(hub): adjust EventFrame.payload assertions for AGUIEvent[]"
```

If no changes were needed, skip the commit step.

---

## Phase D — PWA (sequential single subagent)

**Prerequisite:** Phase A merged.

### Task D1: useHub reducer flattens `EventFrame.payload[]` into buffer entries

**Files:**
- Modify: `packages/pwa/src/hooks/useHub.ts:18-25` (the `appendEvent` reducer helper)
- Modify: PWA test if one exists for the reducer

- [ ] **Step 1: Inspect current `appendEvent` shape**

Read `packages/pwa/src/hooks/useHub.ts:14-30`. The current shape:

```typescript
function appendEvent(
  existing: EventFrameForPwa[],
  frame: EventFrameForPwa,
  max: number = PER_SESSION_BUFFER,
): EventFrameForPwa[] {
  if (existing.some((e) => e.jsonl_offset === frame.jsonl_offset)) return existing;
  const next = existing.concat([frame]);
  return next.length > max ? next.slice(next.length - max) : next;
}
```

- [ ] **Step 2: Define the buffer entry shape**

The buffer can no longer hold `EventFrameForPwa` directly — it needs to hold one record per AG-UI event, keyed by `(jsonl_offset, event_index)`. Add a new type to `useHub.ts`:

```typescript
export interface BufferedEvent {
  daemon_id: string;
  session_id: string;
  jsonl_offset: number;
  event_index: number;       // position within the frame's payload[]
  ts: number;
  event: AGUIEvent;
}
```

Import `AGUIEvent`:

```typescript
import type { AGUIEvent, EventFrameForPwa } from "@cc-remote/proto";
```

- [ ] **Step 3: Replace `appendEvent` to flatten and dedup by `jsonl_offset`**

```typescript
function appendEvent(
  existing: BufferedEvent[],
  frame: EventFrameForPwa,
  max: number = PER_SESSION_BUFFER,
): BufferedEvent[] {
  // Idempotent dedup by jsonl_offset: same row writes once.
  if (existing.some((e) => e.jsonl_offset === frame.jsonl_offset)) return existing;
  const flat: BufferedEvent[] = frame.payload.map((event, event_index) => ({
    daemon_id: frame.daemon_id,
    session_id: frame.session_id,
    jsonl_offset: frame.jsonl_offset,
    event_index,
    ts: frame.ts,
    event,
  }));
  const next = existing.concat(flat);
  return next.length > max ? next.slice(next.length - max) : next;
}
```

- [ ] **Step 4: Update everywhere `events: Record<string, EventFrameForPwa[]>` is referenced**

Find every reference in `useHub.ts`:

```bash
grep -n "EventFrameForPwa\[\]\|events\[k\]\|events:" packages/pwa/src/hooks/useHub.ts
```

Update the `HubState.events` type:

```typescript
events: Record<string, BufferedEvent[]>;
```

Update the history_chunk reducer (around line 126) to flatten the same way:

```typescript
case "history_chunk": {
  const k = eventKey(frame.daemon_id, frame.session_id);
  if (frame.events.length === 0) {
    return { ...prev, noMoreHistory: { ...prev.noMoreHistory, [k]: true } };
  }
  const existing = prev.events[k] ?? [];
  const dedupedOffsets = new Set(existing.map((e) => e.jsonl_offset));
  const newFlat: BufferedEvent[] = [];
  for (const h of frame.events) {
    if (dedupedOffsets.has(h.jsonl_offset)) continue;
    h.payload.forEach((event, event_index) => {
      newFlat.push({
        daemon_id: frame.daemon_id,
        session_id: frame.session_id,
        jsonl_offset: h.jsonl_offset,
        event_index,
        ts: 0, // history doesn't carry ts — derive from event.timestamp if needed
        event,
      });
    });
  }
  // History prepends (older events come at the front).
  const trimmed = [...newFlat, ...existing].slice(0, PER_SESSION_BUFFER);
  return { ...prev, events: { ...prev.events, [k]: trimmed } };
}
```

- [ ] **Step 5: Update `eventKey` and any other consumers if their types changed**

The `eventKey` helper just takes `(daemon_id, session_id)` — should be fine.

- [ ] **Step 6: Run PWA tests**

```bash
bun test packages/pwa/
```

Expected: tests for `mergeTimeline` will fail (Task D4 fixes those). Tests for `useHub` reducer should pass after flatten changes; if any fail, update assertions.

- [ ] **Step 7: Commit**

```bash
git add packages/pwa/src/hooks/useHub.ts
git commit -m "feat(pwa): useHub reducer flattens EventFrame.payload[] into BufferedEvent

Decision #3: live AG-UI events are flat per (jsonl_offset, event_index).
Dedup remains idempotent on jsonl_offset. History reducer applies the
same flattening (decision #3b)."
```

---

### Task D2: `view-helpers.ts`

**Files:**
- Create: `packages/pwa/src/lib/view-helpers.ts`
- Create: `packages/pwa/src/lib/view-helpers.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, test } from "bun:test";
import { EventType, type ToolCallResultEvent } from "@cc-remote/proto";
import {
  toolStatusFromResult,
  formatDuration,
  riskFromToolName,
} from "./view-helpers";

describe("view-helpers", () => {
  test("toolStatusFromResult reads rawEvent.is_error first", () => {
    const ev: ToolCallResultEvent = {
      type: EventType.TOOL_CALL_RESULT,
      messageId: "m1",
      toolCallId: "t1",
      content: "anything",
      rawEvent: { is_error: true },
    };
    expect(toolStatusFromResult(ev)).toBe("failure");
  });

  test("toolStatusFromResult falls back to content heuristic when no rawEvent", () => {
    const ev: ToolCallResultEvent = {
      type: EventType.TOOL_CALL_RESULT,
      messageId: "m1",
      toolCallId: "t1",
      content: "Error: not found",
    };
    expect(toolStatusFromResult(ev)).toBe("failure");
  });

  test("toolStatusFromResult returns success when neither flag fires", () => {
    const ev: ToolCallResultEvent = {
      type: EventType.TOOL_CALL_RESULT,
      messageId: "m1",
      toolCallId: "t1",
      content: "files: a.ts, b.ts",
    };
    expect(toolStatusFromResult(ev)).toBe("success");
  });

  test("formatDuration", () => {
    expect(formatDuration(0, 800)).toBe("0.8s");
    expect(formatDuration(0, 12_000)).toBe("12s");
    expect(formatDuration(undefined, undefined)).toBe("");
  });

  test("riskFromToolName", () => {
    expect(riskFromToolName("Bash")).toBe("warning");
    expect(riskFromToolName("Edit")).toBe("warning");
    expect(riskFromToolName("Write")).toBe("warning");
    expect(riskFromToolName("Read")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
bun test packages/pwa/src/lib/view-helpers.test.ts
```

- [ ] **Step 3: Implement**

```typescript
import type { ToolCallResultEvent } from "@cc-remote/proto";

export type ToolStatus = "success" | "failure";

const ERROR_HEURISTIC = /^(Error|ERROR|error)\b|exit code [^0]|<error/;

export function toolStatusFromResult(ev: ToolCallResultEvent): ToolStatus {
  const raw = (ev as { rawEvent?: { is_error?: unknown } }).rawEvent;
  if (raw && typeof raw.is_error === "boolean") {
    return raw.is_error ? "failure" : "success";
  }
  return ERROR_HEURISTIC.test(ev.content ?? "") ? "failure" : "success";
}

export function formatDuration(start: number | undefined, end: number | undefined): string {
  if (start === undefined || end === undefined) return "";
  const ms = Math.max(0, end - start);
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

export function riskFromToolName(name: string): "warning" | undefined {
  if (name === "Bash" || name === "Edit" || name === "Write" || name === "MultiEdit") {
    return "warning";
  }
  return undefined;
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
bun test packages/pwa/src/lib/view-helpers.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/pwa/src/lib/view-helpers.ts packages/pwa/src/lib/view-helpers.test.ts
git commit -m "feat(pwa): view-helpers — tool status (rawEvent.is_error first), duration formatter, tool risk

Decision #7: tool status reads rawEvent.is_error before content heuristic."
```

---

### Task D3: Replace `TimelineEvent` with `RenderItem`; rewrite `mergeTimeline`

**Files:**
- Modify: `packages/pwa/src/screens/timeline/types.ts` (replace TimelineEvent)
- Modify: `packages/pwa/src/lib/timeline.ts` (rewrite mergeTimeline)
- Modify: `packages/pwa/src/lib/timeline.test.ts` (update test fixtures)

- [ ] **Step 1: Define new `RenderItem` shape in `types.ts`**

Replace the contents of `packages/pwa/src/screens/timeline/types.ts`:

```typescript
import type { AGUIEvent, PwaPermissionRequest, PwaPermissionResolved, PwaChatBroadcast } from "@cc-remote/proto";

/**
 * What the timeline renderer consumes — a thin sum of:
 *   - AG-UI session events (the bulk),
 *   - control-class items that aren't AG-UI (chat broadcasts, permission requests/resolutions).
 *
 * Render dispatch keys off the `tag` and, for `agui` items, off `event.type`.
 */
export type RenderItem =
  | { tag: "agui"; id: string; ts: number; event: AGUIEvent }
  | { tag: "chat"; id: string; ts: number; chat: PwaChatBroadcast }
  | { tag: "permission-inline"; id: string; ts: number; pending: PwaPermissionRequest }
  | { tag: "permission-resolved"; id: string; ts: number; resolved: PwaPermissionResolved };
```

- [ ] **Step 2: Update `lib/timeline.test.ts` to assert on RenderItem shape**

If `lib/timeline.test.ts` exists, update its fixtures to use AGUIEvent inputs. If it does not, create a basic one:

```typescript
import { describe, expect, test } from "bun:test";
import { EventType } from "@cc-remote/proto";
import { mergeTimeline } from "./timeline";

describe("mergeTimeline", () => {
  test("emits 'agui' RenderItems for AGUIEvents in chronological order", () => {
    const items = mergeTimeline({
      events: [
        {
          daemon_id: "d1",
          session_id: "s1",
          jsonl_offset: 100,
          event_index: 0,
          ts: 1000,
          event: {
            type: EventType.TEXT_MESSAGE_CHUNK,
            messageId: "m1",
            role: "assistant",
            delta: "hello",
          },
        },
        {
          daemon_id: "d1",
          session_id: "s1",
          jsonl_offset: 200,
          event_index: 0,
          ts: 2000,
          event: {
            type: EventType.TOOL_CALL_CHUNK,
            toolCallId: "t1",
            toolCallName: "Bash",
            delta: "{\"command\":\"ls\"}",
          },
        },
      ],
      chat: [],
      pending: [],
      resolved: [],
    });
    expect(items.length).toBe(2);
    expect(items[0]?.tag).toBe("agui");
    expect(items[1]?.tag).toBe("agui");
  });

  test("interleaves pending permissions by timestamp", () => {
    const items = mergeTimeline({
      events: [],
      chat: [],
      pending: [
        {
          request_id: "p1",
          daemon_id: "d1",
          session_id: "s1",
          tool: "Bash",
          input: { command: "rm -rf /" },
          ts: 1500,
        } as any,
      ],
      resolved: [],
    });
    expect(items.length).toBe(1);
    expect(items[0]?.tag).toBe("permission-inline");
  });
});
```

- [ ] **Step 3: Run — expect FAIL**

```bash
bun test packages/pwa/src/lib/timeline.test.ts
```

- [ ] **Step 4: Rewrite `lib/timeline.ts`**

Replace the file with:

```typescript
import type {
  PwaChatBroadcast,
  PwaPermissionRequest,
  PwaPermissionResolved,
} from "@cc-remote/proto";
import type { BufferedEvent } from "../hooks/useHub";
import type { RenderItem } from "../screens/timeline/types";

export interface MergeTimelineArgs {
  events: BufferedEvent[];
  chat: PwaChatBroadcast[];
  pending: PwaPermissionRequest[];
  resolved: PwaPermissionResolved[];
}

interface TimedItem {
  tsMs: number;
  rank: number;
  item: RenderItem;
}

const HIDDEN_PAYLOAD_TYPES = new Set<string>([
  // (carried over from the old mergeTimeline — extend as new noise types appear)
  "attachment",
  "summary",
  "queue-operation",
  "mcp_instructions_data",
  "ai-title",
  "last-prompt",
  "permission-mode",
  "pr-link",
]);

export function mergeTimeline(args: MergeTimelineArgs): RenderItem[] {
  const buf: TimedItem[] = [];

  for (const be of args.events) {
    // Filter out RAW events whose source row is project noise.
    if (be.event.type === "RAW") {
      const rawType = (be.event as { event?: { type?: string } }).event?.type;
      if (rawType && HIDDEN_PAYLOAD_TYPES.has(rawType)) continue;
    }
    buf.push({
      tsMs: be.ts,
      rank: 0,
      item: {
        tag: "agui",
        id: `evt:${be.daemon_id}:${be.session_id}:${be.jsonl_offset}:${be.event_index}`,
        ts: be.ts,
        event: be.event,
      },
    });
  }

  for (const c of args.chat) {
    buf.push({
      tsMs: c.ts,
      rank: 1,
      item: {
        tag: "chat",
        id: `chat:${c.message_id}`,
        ts: c.ts,
        chat: c,
      },
    });
  }

  for (const p of args.pending) {
    const ts = (p as { ts?: number }).ts ?? Date.now();
    buf.push({
      tsMs: ts,
      rank: 2,
      item: {
        tag: "permission-inline",
        id: `perm:${p.request_id}`,
        ts,
        pending: p,
      },
    });
  }

  for (const r of args.resolved) {
    const ts = (r as { ts?: number }).ts ?? Date.now();
    buf.push({
      tsMs: ts,
      rank: 3,
      item: {
        tag: "permission-resolved",
        id: `perm-resolved:${r.request_id}`,
        ts,
        resolved: r,
      },
    });
  }

  buf.sort((a, b) => a.tsMs - b.tsMs || a.rank - b.rank);
  return buf.map((t) => t.item);
}
```

- [ ] **Step 5: Run — expect PASS**

```bash
bun test packages/pwa/src/lib/timeline.test.ts
```

- [ ] **Step 6: Update `useSessionTimeline.ts` to consume new `RenderItem`**

In `packages/pwa/src/hooks/useSessionTimeline.ts`, change the `items: TimelineEvent[]` field on `UseSessionTimelineResult` to `items: RenderItem[]`. The `mergeTimeline` call site already passes the right shapes.

- [ ] **Step 7: Run all PWA tests**

```bash
bun test packages/pwa/
```

Some tests will fail at this point — those that exercise renderTimelineItem or specific cards. Task D4 fixes those.

- [ ] **Step 8: Commit**

```bash
git add packages/pwa/src/lib/timeline.ts packages/pwa/src/lib/timeline.test.ts packages/pwa/src/screens/timeline/types.ts packages/pwa/src/hooks/useSessionTimeline.ts
git commit -m "refactor(pwa): retire TimelineEvent; mergeTimeline emits RenderItem (AGUIEvent + control items)

Decision #9: PWA renders straight from AGUIEvent with thin RenderItem
sum. mergeTimeline keeps the chronological merge of events + chat +
permission state but no longer normalises into TimelineEvent."
```

---

### Task D4: Rewrite `renderTimelineItem.tsx` to dispatch on AGUIEvent type

**Files:**
- Modify: `packages/pwa/src/screens/timeline/renderTimelineItem.tsx`
- Modify: `packages/pwa/src/screens/timeline/cards/AssistantBubble.tsx`
- Modify: `packages/pwa/src/screens/timeline/cards/UserBubble.tsx`

- [ ] **Step 1: Update card *Live components to take AGUIEvent props**

Edit `packages/pwa/src/screens/timeline/cards/AssistantBubble.tsx`. Change `AssistantBubbleLive` signature:

```typescript
import type { TextMessageChunkEvent } from "@cc-remote/proto";
import { ChatBubble } from "../../primitives/ChatBubble";

export function AssistantBubble() {
  return <AssistantBubbleLive event={{ type: "TEXT_MESSAGE_CHUNK", messageId: "demo", role: "assistant", delta: "I'll plan the implementation." } as TextMessageChunkEvent} ts={Date.now()} />;
}

export function AssistantBubbleLive({ event, ts }: { event: TextMessageChunkEvent; ts: number }) {
  const time = new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return (
    <ChatBubble align="start" tone="neutral">
      <p className="whitespace-pre-wrap">{event.delta ?? ""}</p>
      <p className="text-muted-foreground mt-1 text-[11px]">{time}</p>
    </ChatBubble>
  );
}
```

Same for `packages/pwa/src/screens/timeline/cards/UserBubble.tsx`.

- [ ] **Step 2: Rewrite `renderTimelineItem.tsx` to dispatch on `RenderItem.tag` and `event.type`**

```typescript
import {
  ChevronRight,
  type LucideIcon,
  Pencil,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  FileText,
} from "lucide-react";
import { useState } from "react";
import type React from "react";
import { EventType, type AGUIEvent, type ToolCallChunkEvent, type ToolCallResultEvent, type ReasoningMessageChunkEvent, type RawEvent } from "@cc-remote/proto";
import { Button } from "../../components/ui/button";
import { CatalogCard, type CatalogCardTone } from "./cards/CatalogCard";
import { CatalogHeader } from "./cards/CatalogHeader";
import { AssistantBubbleLive } from "./cards/AssistantBubble";
import { UserBubbleLive } from "./cards/UserBubble";
import { SessionTimelineItem, type TimelineMarker } from "./SessionTimelineItem";
import type { RenderItem } from "./types";
import { toolStatusFromResult, riskFromToolName } from "../../lib/view-helpers";

export interface RenderTimelineItemContext {
  onOpenPermission?: (request_id: string) => void;
}

export function renderTimelineItem(
  item: RenderItem,
  ctx: RenderTimelineItemContext = {},
): React.ReactElement {
  const marker = pickMarker(item);

  switch (item.tag) {
    case "permission-inline":
      return (
        <SessionTimelineItem key={item.id} marker={marker}>
          <CatalogCard tone="warning">
            <CatalogHeader icon={ShieldAlert} title="Permission required" tone="warning" />
            <div className="mt-3 grid gap-1 text-xs">
              <p>Tool <span className="ml-6 font-mono">{item.pending.tool}</span></p>
            </div>
            <Button className="mt-3 w-full" size="sm" variant="secondary"
              onClick={() => ctx.onOpenPermission?.(item.pending.request_id)}>
              Review
            </Button>
          </CatalogCard>
        </SessionTimelineItem>
      );

    case "permission-resolved":
      return (
        <SessionTimelineItem key={item.id} marker={marker}>
          <CatalogCard tone={item.resolved.decision === "allowed" ? "success" : "danger"}>
            <CatalogHeader icon={ShieldCheck}
              title={
                item.resolved.decision === "allowed" ? "Permission granted"
                : item.resolved.decision === "denied" ? "Permission denied"
                : "Permission expired"
              }
              tone={item.resolved.decision === "allowed" ? "success" : "danger"} />
          </CatalogCard>
        </SessionTimelineItem>
      );

    case "chat":
      return (
        <SessionTimelineItem key={item.id} align="end" marker={marker}>
          <UserBubbleLive event={{ type: EventType.TEXT_MESSAGE_CHUNK, messageId: item.id, role: "user", delta: item.chat.text }} ts={item.ts} />
        </SessionTimelineItem>
      );

    case "agui":
      return renderAgUi(item.id, item.event, item.ts, marker);
  }
}

function renderAgUi(id: string, event: AGUIEvent, ts: number, marker: TimelineMarker): React.ReactElement {
  switch (event.type) {
    case EventType.TEXT_MESSAGE_CHUNK: {
      const role = (event as { role?: string }).role;
      if (role === "user") {
        return (
          <SessionTimelineItem key={id} align="end" marker={marker}>
            <UserBubbleLive event={event as any} ts={ts} />
          </SessionTimelineItem>
        );
      }
      return (
        <SessionTimelineItem key={id} marker={marker}>
          <AssistantBubbleLive event={event as any} ts={ts} />
        </SessionTimelineItem>
      );
    }

    case EventType.REASONING_MESSAGE_CHUNK: {
      const ev = event as ReasoningMessageChunkEvent;
      return (
        <SessionTimelineItem key={id} marker={marker}>
          <CatalogCard>
            <CatalogHeader title="Reasoning" />
            <p className="mt-2 text-sm leading-5 whitespace-pre-wrap">{ev.delta ?? "(no reasoning text)"}</p>
          </CatalogCard>
        </SessionTimelineItem>
      );
    }

    case EventType.TOOL_CALL_CHUNK: {
      const ev = event as ToolCallChunkEvent;
      return (
        <SessionTimelineItem key={id} marker={marker}>
          <ToolChunkCard event={ev} ts={ts} />
        </SessionTimelineItem>
      );
    }

    case EventType.TOOL_CALL_RESULT: {
      const ev = event as ToolCallResultEvent;
      return (
        <SessionTimelineItem key={id} marker={marker}>
          <ToolResultCard event={ev} />
        </SessionTimelineItem>
      );
    }

    case EventType.RUN_STARTED:
    case EventType.RUN_FINISHED:
      // FSM markers — not rendered as cards in v1; the SessionView already
      // shows the working/idle state via the daemon view model.
      return <></> as unknown as React.ReactElement;

    case EventType.RUN_ERROR: {
      const msg = (event as { message?: string }).message ?? "Run error";
      return (
        <SessionTimelineItem key={id} marker={marker}>
          <CatalogCard tone="danger">
            <CatalogHeader title="Run error" tone="danger" />
            <p className="mt-2 text-xs">{msg}</p>
          </CatalogCard>
        </SessionTimelineItem>
      );
    }

    case EventType.RAW: {
      const ev = event as RawEvent;
      return (
        <SessionTimelineItem key={id} marker={marker}>
          <CatalogCard>
            <CatalogHeader title="Raw event" />
            <pre className="bg-muted mt-3 max-h-40 overflow-auto rounded-md p-2 font-mono text-xs leading-5">
              {JSON.stringify(ev.event, null, 2)}
            </pre>
          </CatalogCard>
        </SessionTimelineItem>
      );
    }

    default:
      return (
        <SessionTimelineItem key={id} marker={marker}>
          <CatalogCard>
            <CatalogHeader title={String(event.type)} />
          </CatalogCard>
        </SessionTimelineItem>
      );
  }
}

function pickMarker(item: RenderItem): TimelineMarker {
  if (item.tag === "permission-inline") return "warning";
  if (item.tag === "permission-resolved") {
    return item.resolved.decision === "denied" || item.resolved.decision === "expired" ? "error" : "success";
  }
  if (item.tag === "chat") return "user";
  // tag === "agui"
  switch (item.event.type) {
    case EventType.TEXT_MESSAGE_CHUNK:
      return (item.event as { role?: string }).role === "user" ? "user" : "claude";
    case EventType.REASONING_MESSAGE_CHUNK:
      return "claude";
    case EventType.TOOL_CALL_CHUNK:
    case EventType.TOOL_CALL_RESULT:
    case EventType.ACTIVITY_SNAPSHOT:
    case EventType.ACTIVITY_DELTA:
      return "tool";
    case EventType.RUN_ERROR:
      return "error";
    default:
      return "idle";
  }
}

function pickStrongToolIcon(name: string): LucideIcon | undefined {
  if (!name) return undefined;
  if (name === "Bash") return Terminal;
  if (name === "Edit" || name === "Write" || name === "MultiEdit") return Pencil;
  if (name === "Read") return FileText;
  return undefined;
}

function ToolChunkCard({ event, ts }: { event: ToolCallChunkEvent; ts: number }) {
  const name = (event as { toolCallName?: string }).toolCallName ?? "tool";
  const icon = pickStrongToolIcon(name);
  const args = (event as { delta?: string }).delta ?? "";
  return (
    <CatalogCard>
      <CatalogHeader icon={icon} title={name}
        status={<span className="bg-muted text-muted-foreground rounded-md border px-2 py-0.5 text-xs font-medium">Active</span>} />
      {args && (
        <pre className="bg-muted mt-2 max-h-32 overflow-auto rounded-md p-2 font-mono text-xs leading-5 whitespace-pre-wrap break-all">
          <code>{args}</code>
        </pre>
      )}
    </CatalogCard>
  );
}

function ToolResultCard({ event }: { event: ToolCallResultEvent }) {
  const [expanded, setExpanded] = useState(false);
  const status = toolStatusFromResult(event);
  const cardTone: CatalogCardTone = status === "failure" ? "danger" : "default";
  const out = event.content ?? "";
  const lines = out ? out.split("\n") : [];
  const isShort = status === "success" && lines.length <= 2 && out.length <= 200;
  const showExpand = !!out && (status === "failure" || !isShort);

  return (
    <CatalogCard tone={cardTone}>
      <CatalogHeader title="Result" tone={status === "failure" ? "danger" : "success"}
        status={
          <span className={`shrink-0 rounded-md border px-2 py-0.5 text-xs font-medium ${
            status === "success" ? "bg-success-subtle text-success border-success/30" : "bg-danger-subtle text-danger border-danger/30"
          }`}>
            {status === "success" ? "Success" : "Failed"}
          </span>
        } />
      {isShort && <p className="text-muted-foreground mt-2 font-mono text-xs whitespace-pre-wrap">{out}</p>}
      {showExpand && (
        <>
          <Button className="mt-2 w-full justify-between" size="sm" variant="ghost"
            onClick={() => setExpanded((v) => !v)}>
            <span>{expanded ? "Hide output" : `View output (${lines.length} lines)`}</span>
            <ChevronRight className={`size-4 transition-transform ${expanded ? "rotate-90" : ""}`} />
          </Button>
          {expanded && (
            <pre className="bg-muted mt-2 max-h-60 overflow-auto rounded-md p-2 font-mono text-xs leading-5 whitespace-pre-wrap">
              {out}
            </pre>
          )}
        </>
      )}
    </CatalogCard>
  );
}
```

- [ ] **Step 3: Update consumers of `renderTimelineItem`**

```bash
grep -rn "renderTimelineItem" packages/pwa/src/
```

Wherever it's called with a `TimelineEvent`, the call site needs to pass a `RenderItem`. The flow `useSessionTimeline → mergeTimeline → renderTimelineItem` already produces `RenderItem[]` after Task D3, so the only consumers to check are static fixtures or stories.

- [ ] **Step 4: Run PWA tests**

```bash
bun test packages/pwa/
```

Fix any test fixture that assembles a fake `TimelineEvent` — replace with `RenderItem` shape.

- [ ] **Step 5: Typecheck**

```bash
bunx tsc --noEmit -p packages/pwa
```

Fix remaining errors. The most likely are imports of `TimelineEvent` from `screens/timeline/types`. Replace with `RenderItem` or adjust as appropriate.

- [ ] **Step 6: Commit**

```bash
git add packages/pwa/src/screens/timeline/renderTimelineItem.tsx packages/pwa/src/screens/timeline/cards/AssistantBubble.tsx packages/pwa/src/screens/timeline/cards/UserBubble.tsx
git commit -m "feat(pwa): renderTimelineItem dispatches on AGUIEvent type and RenderItem.tag

Cards consume AGUIEvent props directly; tool result rendering uses
toolStatusFromResult (rawEvent.is_error first, content heuristic
fallback)."
```

---

### Task D5: Delete demo-only cards and prune `DemoApp.tsx` mock data

**Files:**
- DELETE: `packages/pwa/src/screens/timeline/cards/TaskCreatedCard.tsx`
- DELETE: `packages/pwa/src/screens/timeline/cards/TaskCompletedCard.tsx`
- DELETE: `packages/pwa/src/screens/timeline/cards/IdleWaitingCard.tsx`
- Modify: `packages/pwa/src/screens/timeline/cards/index.ts` (drop 3 exports)
- Modify: `packages/pwa/src/demo/DemoApp.tsx` (drop 3 imports + 3 usages + the `kind:"task"` mock data)

**Important — what NOT to delete (re-read spec §6 (e)):**
The `task_completed` and `idle` daemon-to-hub control-class frames in `packages/proto/src/frames.ts` and their handlers in `packages/hub/src/router.ts:133` and `packages/pwa/src/hooks/useHub.ts:167` drive `completedCounts` and push notification preferences. Do **not** touch those.

- [ ] **Step 1: Delete the 3 card files**

```bash
rm packages/pwa/src/screens/timeline/cards/TaskCreatedCard.tsx
rm packages/pwa/src/screens/timeline/cards/TaskCompletedCard.tsx
rm packages/pwa/src/screens/timeline/cards/IdleWaitingCard.tsx
```

- [ ] **Step 2: Drop them from the barrel**

In `packages/pwa/src/screens/timeline/cards/index.ts`, remove these lines:

```typescript
// remove:
export { TaskCreatedCard } from "./TaskCreatedCard";
export { TaskCompletedCard } from "./TaskCompletedCard";
export { IdleWaitingCard } from "./IdleWaitingCard";
```

- [ ] **Step 3: Prune `DemoApp.tsx`**

```bash
grep -n "TaskCreatedCard\|TaskCompletedCard\|IdleWaitingCard\|kind: \"task\"\|kind: \"idle\"" packages/pwa/src/demo/DemoApp.tsx
```

For each match, delete the import line, the JSX usage, or the mock data entry. Where a `kind:"task"` mock-event entry is removed, also remove any surrounding `<TaskRowCard event={…} />` consumer that referenced it.

- [ ] **Step 4: Typecheck and run**

```bash
bunx tsc --noEmit -p packages/pwa
bun test packages/pwa/
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/pwa/src/screens/timeline/cards/ packages/pwa/src/demo/DemoApp.tsx
git commit -m "chore(pwa): delete demo-only cards (Task{Created,Completed}, IdleWaiting)

Live mergeTimeline never produced kind: task / kind: idle. The
task_completed and idle daemon-to-hub control-class frames are
unrelated and untouched (they drive push prefs and completedCounts)."
```

---

## Phase E — integration

### Task E1: Full sweep — packages + e2e-real

- [ ] **Step 1: Per-package typecheck**

```bash
bunx tsc --noEmit -p packages/proto
bunx tsc --noEmit -p packages/daemon
bunx tsc --noEmit -p packages/hub
bunx tsc --noEmit -p packages/plugin
bunx tsc --noEmit -p packages/pwa
```

Fix any remaining type errors inline.

- [ ] **Step 2: Per-package unit tests**

```bash
bun test packages/proto/
bun test packages/daemon/
bun test packages/hub/
bun test packages/plugin/
bun test packages/pwa/
```

Each must be green.

- [ ] **Step 3: Real-component e2e**

```bash
bun test e2e-real/
```

Expected: full suite green (~5-6 min wall time).

If any e2e scenario fails because it asserts on raw JSONL payload shape, update the assertion to inspect the AG-UI event(s) inside `payload[]`. Do **not** revert any wire-format changes — the e2e suite is the integration check, not the regressing check.

- [ ] **Step 4: Final commit (any test fixture updates from this task)**

```bash
git add -p
git commit -m "test: update e2e-real assertions for AGUIEvent[] payload"
```

- [ ] **Step 5: Tag**

```bash
git tag plan-ag-ui-adoption
```

---

## Out of Scope (deferred to future plans)

- **Phase 3 graduation fixtures** — capture real-data tapes for compact / subagent / batch / concurrent-tools / malformed rows / run-vs-tool-errors / long-reasoning / multi-RUN. Not blocking AG-UI adoption but blocks the "AG-UI adoption complete" tag in spec §10.
- **CodexAdapter** — `packages/daemon/src/adapters/codex.ts` consuming `codex exec --json`. Spec §7 phase 3.
- **Permission migration to AG-UI Interrupt/Resume** — task #8, blocked on `@ag-ui/core` SDK exposing the typed shape.
- **`tool_status` CUSTOM convention** — task #9, gated on the v1 PWA-side rawEvent → heuristic resolution proving unreliable in multi-agent mode.
- **Runtime zod validation at daemon→hub boundary** — optional; safe to add later.

---

## Self-Review

**1. Spec coverage:**
- ✅ Decision #1 (multi-agent goal): scaffolded by `AgentAdapter` interface (Task B1).
- ✅ Decision #2 (adapter in daemon): Tasks B1-B3.
- ✅ Decision #3 (`AGUIEvent[]` wire format + flatten): Tasks A2, B2, B3, D1.
- ✅ Decision #3b (history parity): Task B3.
- ✅ Decision #4 (type-only SDK): respected throughout (no runtime zod).
- ✅ Decision #5 (RUN_* from FSM only): Task A1 contract test + Task B4 implementation.
- ✅ Decision #6 (permission stays on control-class frames): no permission frame changes anywhere; renderTimelineItem still consumes pending/resolved.
- ✅ Decision #7 (rawEvent.is_error first, heuristic fallback): Task A1 contract test + Task D2.
- ✅ Decision #8 (REASONING_* only): Task A1 contract test + renderTimelineItem dispatches REASONING_MESSAGE_CHUNK.
- ✅ Decision #9 (TimelineEvent retires): Tasks D3, D4.
- ✅ Decision #10 (CUSTOM = 0 in v1): Task A1 contract test + spike CUSTOM emitters stripped.
- ✅ Decision #11 (three-layer rule): Task A1 enforces (a) standard AG-UI, (c) rawEvent preserved; (b) v1 has none.
- ✅ Decision #12 (no flags / shadow): no flag wiring anywhere in the plan.
- ✅ Spec §6 cards (a-e): rewriting cards (a) is folded into Task D4 dispatch + 2 *Live components (the rest of the cards in (a) bucket are not actually called from `renderTimelineItem` for live data; they are static demo decorations and remain untouched). Demo-only deletions in (e) covered by Task D5. Layout primitives (d) untouched. Control-class cards (b) `PermissionInlineCard`/`PermissionResolvedCard` are inlined in `renderTimelineItem.tsx` (current shape) — preserved verbatim.
- ✅ Spec §7 phase 3 explicitly deferred.

**2. Placeholder scan:** no TBD / TODO / "implement later" / "similar to Task N" — every step has concrete code or commands.

**3. Type consistency:**
- `BufferedEvent` (D1) shape matches what `mergeTimeline` (D3) consumes.
- `RenderItem` (D3) shape matches what `renderTimelineItem` (D4) dispatches on.
- `ConvertContext` (B1) named-args (`sessionId`, `jsonlOffset`) match what `index.ts` (B2) and `jsonl-history.ts` (B3) call with.
- `fromClaudeCode` (proto) signature `(row, ctx: { threadId, runId })` matches what `ClaudeCodeAdapter.convertRow` (B1) maps to.

**4. Subagent readiness:** Phase A is one subagent (sequential, same files). Phase B is one subagent. Phase C is one task (verify only). Phase D is one subagent. Phase E is the final integration. After Phase A merges, B/C/D dispatched in parallel.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-25-ag-ui-adoption-plan.md`. Execution will use **subagent-driven-development** per the goal.
