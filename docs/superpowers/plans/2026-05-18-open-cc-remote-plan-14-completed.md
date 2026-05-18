# open-cc-remote — Plan 14: task_completed typed event

> **For agentic workers:** Compressed. Full code in dispatch prompts.

**Goal:** Daemon parses Claude Code JSONL lines and emits a dedicated `task_completed` event when an assistant message has a `stop_reason: "end_turn"` (or similar terminal stop reason). Hub fans out to PWAs; PWA can show with a ✓ marker. Push opt-in flag added (default off).

**Architecture:**
- daemon's existing JSONL watcher already calls `onLine(line, offset)` and emits a generic `event` frame with `payload: <parsed>`. We add a side-channel: same handler also detects the `assistant` + terminal stop_reason pattern and emits an additional `task_completed` frame.
- hub Router routes the new typed frame, broadcasts to PWAs.
- preferences gain `completed?: boolean` (default false → opt-in)

**Out of scope:** idle detection (timed inactivity).

---

## Tasks

### T1 — Proto: task_completed frames + no-op handlers

Add `TaskCompletedFrame` (daemon→hub: session_id, ts) and `PwaTaskCompletedFrame` (with daemon_id added). Extend unions. No-op cases in router/ws.

### T2 — Daemon: detection + emit

In `packages/daemon/src/index.ts`'s session register handler (where the watcher is created), in the `onLine` callback, after emitting the regular `event` frame, additionally check: if `payload.type === "assistant"` and `payload.message?.stop_reason === "end_turn"`, also send a `task_completed` frame.

Tests not strictly needed at unit level — exercised in T4 e2e.

### T3 — Hub: route task_completed + push opt-in

Router handles the new daemon→hub frame (broadcast). Add `dispatchCompletedPush` similar to `dispatchOfflinePush` filtering by `prefs.completed === true`. Tests for both router fanout and push gate.

### T4 — PWA: handle frame + service worker + preferences toggle

ws.ts no-op replaced: tracks the count of completed events per session for a small ✓ badge. Settings.tsx adds the toggle. sw.js handles `kind: "completed"`.

### T5 — e2e

Pre-fill JSONL with an assistant-line with stop_reason. Verify task_completed frame surfaces at PWA WSS.

### T6 — README + tag

Tag `plan-14-completed`.
