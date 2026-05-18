# open-cc-remote — Plan 15: idle event

> **For agentic workers:** Compressed. Full code in dispatch prompts.

**Goal:** Emit a typed `idle` event when Claude Code has been waiting for user input for N seconds (default 30s) after finishing a turn.

**Architecture:** Builds on Plan 14. After a `task_completed` frame is emitted (assistant + stop_reason=end_turn), daemon starts an idle timer per session. Any new JSONL line cancels it. If the timer fires (no activity within window), daemon emits an `idle` frame. Hub fans out + pushes (opt-in `prefs.idle`).

---

## Tasks

### T1 — Pipeline: proto + daemon timer + hub routing + push

- proto adds IdleFrame (daemon→hub) + PwaIdleFrame
- daemon adds per-session timer state. On task_completed condition met → start setTimeout. On any new line for that session → clear timer. On fire → emit `idle` frame.
- daemon config adds `idle_window_ms: number` (default 30000)
- hub Router adds case + dispatchIdlePush helper (opt-in)
- preferences add `idle?: boolean`

Tests: 3 router tests (fanout, push opt-in, push default-off).

### T2 — PWA + service worker

- ws.ts apply handles `idle` (track per-session zzz state for visual indicator)
- App.tsx shows a 💤 badge per session
- Settings.tsx adds idle toggle
- sw.js handles kind: "idle"

### T3 — e2e + README + tag

E2E: pre-fill JSONL with assistant+end_turn line, set `idle_window_ms: 200`, wait 500ms, assert idle frame arrives. Then test that a fresh user line within window cancels.

README + tag plan-15-idle.
