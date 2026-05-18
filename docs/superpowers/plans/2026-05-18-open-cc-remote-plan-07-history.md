# open-cc-remote — Plan 7: Conversation history scroll-back

> **For agentic workers:** Compressed format. Full code in dispatch prompts.

**Goal:** PWA's SessionPane can scroll up to load older events from a session's JSONL file. Daemon reads the JSONL backwards from a given offset and returns N lines. Hub routes the request and response.

**Architecture:**
- New PWA→hub frame: `request_history { daemon_id, session_id, before_offset, limit }`
- New hub→daemon frame: `request_history { session_id, before_offset, limit, request_id }` (request_id correlates the response)
- New daemon→hub frame: `history_chunk { session_id, request_id, events: [{ jsonl_offset, payload }] }`
- New hub→PWA frame: `history_chunk` (forwarded with daemon_id added)
- Daemon reads the JSONL file from the start, walks forward collecting line offsets, returns the last N before `before_offset`. (Reverse line scan in a JSON-line file is fiddly because lines vary in length; forward scan + collect is simplest and fine for typical session sizes.)

**Out of scope:** all the other "Plan 7+" items (still Plan 8+).

---

## Tasks

### T1 — Proto: history frames

Add `RequestHistoryFrame` (3 variants for the 3 hops) and `HistoryChunkFrame` (2 variants — daemon→hub plain, hub→PWA with daemon_id). Extend the relevant unions. Add no-op cases in router.ts and ws.ts to satisfy exhaustiveness (real handlers in T3/T4).

### T2 — Daemon: reverse history reader

`packages/daemon/src/jsonl-history.ts`:
```ts
export async function readHistory(path: string, before_offset: number, limit: number):
  Promise<Array<{ jsonl_offset: number; payload: unknown }>>;
```
Strategy: open file, read forward, collect each line's end-offset, accumulate up to limit lines whose end-offset ≤ before_offset (most recent first). For typical Claude Code sessions (≤ a few MB) this is fine. Tests for: small file, exact-offset boundary, less than `limit` available, non-existent file (returns []).

### T3 — Daemon: handle request_history from hub

`packages/daemon/src/index.ts`:
- Track active live sessions' jsonl_path (already computable via `jsonlPath(s.cwd, s.session_id)`)
- On hub `request_history` frame: read history, send `history_chunk` back with same `request_id`

### T4 — Hub Router routes history frames

- PWA→hub `request_history` → router.onPwaCommand: forward to daemonReg.send
- daemon→hub `history_chunk` → broadcast to PWAs (with daemon_id added)
- The PWA→hub frame includes `daemon_id` so the router knows where to send.

Add tests for both directions.

### T5 — PWA: scroll-up to load history

In `SessionPane.tsx`: when scrollTop is near 0 and not already loading, send a `request_history` with the oldest known `jsonl_offset` from the events array (or `Number.MAX_SAFE_INTEGER` if empty). On receiving `history_chunk` matching that session, prepend events. ws.ts needs a sender hook (`requestHistory`) and a debounce-style guard against duplicate concurrent requests.

### T6 — e2e test

Spawn full stack with HUB_DISABLE_AUTH. Pre-create a JSONL file with 5 lines. Plugin registers, then PWA sends request_history. Verify history_chunk arrives with all 5 lines.

### T7 — README + tag

Document the feature. Tag `plan-07-history`.
