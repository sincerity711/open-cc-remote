# AG-UI Adoption Design

Date: 2026-05-25
Status: Approved (brainstorming complete; ready for plan)

## 1. Motivation

The PWA today renders Claude Code sessions through a project-internal `TimelineEvent` discriminated union (`packages/pwa/src/screens/timeline/types.ts`) fed from raw JSONL payloads. This works, but the schema is private and Claude-specific. The goal is to drive multiple agent backends — first **Claude Code**, later **Codex / Gemini CLI / OpenHands** — through the same PWA.

Adopting [AG-UI](https://docs.ag-ui.com) (Agent-User Interaction Protocol) as the canonical session-event format gives us:

- A standard taxonomy (`TEXT_MESSAGE_*`, `TOOL_CALL_*`, `REASONING_*`, `ACTIVITY_*`, `RUN_*`, `STATE_*`, `RAW`, `CUSTOM`) the PWA can render uniformly.
- A clean per-agent adapter boundary (`ClaudeCodeAdapter`, `CodexAdapter`, …) inside the daemon.
- Optional future interop with external AG-UI clients (CopilotKit etc.).

## 2. Spike Result (2026-05-25)

A spike landed under `packages/proto/src/agui/` validated the protocol's expressiveness:

- **Round-trip**: 6/6 real JSONL tapes (`e2e-real/fixtures/jsonl-tapes/{bash-failure,bash-success,channel-injection,long-output,read-then-edit,thinking-then-tool}.jsonl`) → AG-UI events → reconstructed `TimelineEvent` were kind/order/payload-equivalent to the existing `mergeTimeline` output.
- **SDK**: `@ag-ui/core@0.0.53` is sufficient for type-only import. 33 standard `EventType` values cover the bulk of our needs.
- **Gaps**: AG-UI has no native HITL / Interrupt / Resume events in 0.0.53; `TOOL_CALL_RESULT` lacks `is_error`; `THINKING_*` is deprecated in favour of `REASONING_*`.
- **Tests**: `bun test packages/proto/tests/agui/` — 7 pass, 18 expect() calls, ~40 ms.
- **Status**: spike code is in working tree but uncommitted; phase 1 of this design promotes it.

## 3. Core Decisions

| # | Decision |
|---|---|
| 1 | **Goal**: support multiple agent backends through a single PWA. |
| 2 | **Adapter location**: inside the daemon, behind an `AgentAdapter` interface. Each daemon instance binds one adapter. |
| 3 | **Wire format**: daemon → hub → PWA "session events" carry **AG-UI events** in `EventFrame.payload`, typed as **`AGUIEvent[]`** (not single event). One frame = one JSONL row = N AG-UI events (a single Claude row can contain assistant text + tool_use + thinking blocks; each becomes its own AG-UI event but they share `jsonl_offset`). The PWA `useHub` reducer flattens the array on insert: dedup remains keyed by `jsonl_offset` (same row writes idempotently), but the in-memory buffer carries one entry per `(jsonl_offset, event_index)`. **Control-class frames** (auth / register / pair / `permission_request` / `permission_resolved` / `chat_send` / `start_session` / `kill_session` / `task_completed` / `idle` / history) **stay unchanged**. |
| 3b | **History parity**: `daemon/jsonl-history` runs the same `fromClaudeCode` adapter as the live path. `HistoryEvent.payload` becomes `AGUIEvent[]`, not `unknown`. Daemon is the only raw-JSONL → AG-UI conversion site; hub and PWA never see raw payloads. |
| 4 | **SDK**: `@ag-ui/core@0.0.53`, **type-only import**. Runtime zod schemas may be invoked at the daemon→hub boundary as optional validation, but never bundled into the PWA. |
| 5 | **`RUN_STARTED / RUN_FINISHED / RUN_ERROR`**: emitted by the daemon's session FSM at `working ↔ idle` and spawn-fail boundaries. The row mapper (`fromClaudeCode`) **must not** synthesise them. |
| 6 | **Permission / HITL**: **not** in the AG-UI session-event path. Continues over existing `PwaPermissionRequest` / `PwaPermissionResolved` control-class frames. Migration deferred (task #8): AG-UI protocol-level docs describe interrupt as `RUN_FINISHED.outcome.type = "interrupt"` + `RunAgentInput.resume`, but `@ag-ui/core@0.0.53` does not yet expose this as a typed shape in its `EventType` enum. Migrate when the SDK surfaces it, or when we choose to encode the `outcome` variant ourselves. |
| 7 | **Tool failure**: no `tool_status` AG-UI event, no CUSTOM event. Adapter contract (binding for every `from-*.ts`): **must preserve `is_error: boolean` (and any equivalent failure flag from non-Claude sources) on `TOOL_CALL_RESULT.rawEvent` under a documented field name** (`rawEvent.is_error` for Claude). PWA failure-render helper reads `rawEvent.is_error` first, falls back to content-string heuristic. This honours amendment "do not hide product semantics *only* in rawEvent": rawEvent is the primary encoding **and** the heuristic provides a second source. If multi-agent ergonomics deteriorate, revisit per task #9. |
| 8 | **Reasoning**: `REASONING_MESSAGE_CHUNK` only. `THINKING_*` is forbidden — adapters must not emit it. Codebase enforces via test assertion or lint. |
| 9 | **`TimelineEvent` retires**. PWA cards consume `AGUIEvent` (plus control-class frames) directly. No intermediate type. |
| 10 | **CUSTOM events in v1**: **zero**. Anything AG-UI's standard taxonomy can't express falls through to `RAW`, rendered by the existing `RawJsonCard` / `SystemNoticeCard`. |
| 11 | **Three-layer adapter rule** (binding contract for `from-claude-code.ts`, future `from-codex.ts`, …): (a) emit standard AG-UI events where semantics exist; (b) emit `CUSTOM` only for irreducibly project-specific semantics; (c) preserve the source row in `rawEvent` for debug and forward-compat. v1 has no (b) entries. |
| 12 | **Rollout**: 3 ordered phases, no feature flags / shadow mode. Personal-project pace; revert by `git revert` if needed. |

## 4. Architecture

```
Claude Code session.jsonl
        │
        ▼
daemon.jsonl-bind  ── parses JSONL line ──▶  ClaudeCodeAdapter.fromClaudeCode(row, ctx)
                                                       │
                                                       ▼
                                               AGUIEvent[]
                                                       │
                                            (FSM emits RUN_* on state transitions)
                                                       │
                                                       ▼
daemon → hub : EventFrame { type: "event", session_id, jsonl_offset, ts, payload: AGUIEvent[] }
        │                                                  ╲
        │ control-class frames unchanged ────────────▶  PwaPermissionRequest / Resolved
        │                                              PwaChatBroadcast, SessionSnapshot,
        │                                              TaskCompletedFrame, IdleFrame, …
        ▼
hub → PWA : EventFrameForPwa { ..., payload: AGUIEvent[], daemon_id }
        │
        ▼
PWA useHub flattens payload[] → buffer entries keyed by (jsonl_offset, event_index);
   dedup is by jsonl_offset (same row writes idempotently)
        │
        ▼
mergeTimeline(events: AGUIEvent[], chat, pending, resolved)
        │
        ▼
cards (AssistantBubble / BashToolCard / FileEditCard / … / RawJsonCard fallback)
```

Future Codex path follows the same shape with `CodexAdapter` consuming `codex exec --json` and emitting `AGUIEvent[]`.

## 5. Event Mapping (Claude Code JSONL → AG-UI)

| JSONL semantic | AG-UI event | Notes |
|---|---|---|
| `user` text block | `TEXT_MESSAGE_CHUNK` (role=user) | Channel envelope (cc-remote chat injection) is stripped by adapter |
| `assistant` text block | `TEXT_MESSAGE_CHUNK` (role=assistant) | Includes prose extracted from `mcp__cc-remote__reply` tool calls |
| `assistant` thinking block | `REASONING_MESSAGE_CHUNK` | Deprecated `THINKING_*` not used |
| `tool_use` block (running) | `TOOL_CALL_CHUNK` | Args carried as JSON-stringified `delta`. Client auto-expand handles start/args/end semantics (verified empirically) |
| `tool_result` block | `TOOL_CALL_RESULT` | `content` is the result text. **Adapter must set `rawEvent.is_error: boolean`** as the documented success/failure encoding. PWA reads `rawEvent.is_error` first, falls back to content heuristic |
| TodoWrite / step events (future) | `STEP_STARTED` / `STEP_FINISHED` or `ACTIVITY_DELTA { activityType: "task" }` | Not in v1 — currently demo-only on PWA |
| Subagent invocation | `ACTIVITY_SNAPSHOT { activityType: "subagent" }` | `content` carries children/status/summary |
| Batch summary (multi-tool collapse) | `ACTIVITY_SNAPSHOT { activityType: "batch" }` | |
| Session boundary / compact | `RAW { source: "claude-code-jsonl" }` | Low-frequency; rendered by `RawJsonCard` |
| `system`, `summary`, metadata, `attachment`, `queue-operation`, `mcp_instructions_data`, `ai-title`, `last-prompt`, `permission-mode`, `pr-link` | `RAW` (unless filtered by `HIDDEN_PAYLOAD_TYPES`) | Existing PWA filter list (`packages/pwa/src/lib/timeline.ts`) carries over |
| Fatal turn error | `RUN_ERROR` (daemon-emitted at FSM boundary) | Non-fatal errors → `RAW` |
| Unknown / new JSONL `type` | `RAW` | Forward-compat |
| **Permission request / resolution** | **NOT in AG-UI path** | Stays on `PwaPermissionRequest` / `PwaPermissionResolved` control-class frames |

### Run lifecycle (daemon FSM, not row mapper)

| FSM transition | AG-UI event |
|---|---|
| session spawn → first activity | `RUN_STARTED { threadId: session_id, runId }` |
| activity → idle | `RUN_FINISHED` |
| spawn failure | `RUN_ERROR { message, code }` |

## 6. PWA Card Disposition

After AG-UI cut-over, every existing card falls into one of four buckets:

**(a) Rewritten to consume `AGUIEvent` directly** (~11 cards):
`AssistantBubble`, `UserBubble`, `BashToolCard`, `FileEditCard`, `ReadSearchCard`, `ReasoningCard`, `ToolResultLongCard`, `ToolResultShortCard`, `ToolFailureCard`, `SubagentCard`, `BatchSummaryCard`.

View-derived fields (risk colour, formatted duration, tool icon) move into PWA-side helpers (`packages/pwa/src/lib/view-helpers.ts`, new): `toolSuccessHeuristic(content)`, `formatDuration(start, end)`, `riskFromToolName(name)`.

**(b) Driven by control-class frames, no protocol change**:
`PermissionInlineCard`, `PermissionResolvedCard`.

**(c) Fallback for `RAW` and out-of-band notices**:
`RawJsonCard`, `SystemNoticeCard`.

**(d) Layout primitives, not "cards" per se**:
`CatalogCard`, `CatalogHeader`. Used by everything else as building blocks. Untouched.

**(e) Demo-only — DELETE in v1 cleanup**:
`TaskCreatedCard`, `TaskCompletedCard`, `IdleWaitingCard`. They are referenced only in `packages/pwa/src/demo/DemoApp.tsx`; the live `mergeTimeline` never produces `kind: "task"` or `kind: "idle"`. Delete the three card files **and** prune the corresponding usages and `kind: "task"` / `kind: "idle"` references from `DemoApp.tsx`, `screens/timeline/types.ts`, `renderTimelineItem.tsx`. (The `kind: "idle"` entry in `TimelineEvent` is also unused once `TimelineEvent` itself retires — see decision #9.)

**Important — what NOT to delete**: the `task_completed` and `idle` **daemon-to-hub control-class frames** (`packages/proto/src/frames.ts:327` and `:342`) are NOT timeline events. They drive `completedCounts` and push-notification preferences (`packages/hub/src/router.ts:133` & `:145`, `packages/pwa/src/hooks/useHub.ts:167`). These frames stay untouched in v1. The cleanup is strictly cards + `TimelineEvent` kinds.

## 7. Rollout

```
Phase 1 — proto + daemon
  - Promote spike: keep packages/proto/src/agui/{events.ts, from-claude-code.ts}
    drop to-timeline.ts (no TimelineEvent target anymore)
  - Strip CUSTOM emitters from spike (decision #10 mandates v1 = 0 CUSTOM):
      * delete CcRemoteCustomNames namespace from events.ts
      * delete summary→CUSTOM cc-remote.compact branch in from-claude-code.ts
        (summary becomes RAW)
      * delete the permission CUSTOM builder (permission is not in AG-UI path)
  - Add AgentAdapter interface in packages/daemon/src/adapters/index.ts
  - Implement ClaudeCodeAdapter wrapping fromClaudeCode + raw row context
  - Adapter contract: TOOL_CALL_RESULT events MUST carry rawEvent.is_error
  - Wire format: EventFrame.payload becomes AGUIEvent[] (was: raw JSONL line);
    HistoryEvent.payload also becomes AGUIEvent[] — daemon/jsonl-history runs
    fromClaudeCode on retrieval so live and history share one conversion site
  - daemon session FSM emits RUN_STARTED / RUN_FINISHED / RUN_ERROR at state edges
  - Tests: bun test packages/proto/ , bun test packages/daemon/
    incl. unit test asserting fromClaudeCode never emits THINKING_* and
    never emits CUSTOM (lock decisions #8 and #10)

Phase 2 — PWA
  - Delete packages/pwa/src/screens/timeline/types.ts (TimelineEvent retires)
  - Rewrite packages/pwa/src/lib/timeline.ts mergeTimeline:
      input: { events: AGUIEvent[], chat, pending, resolved }
      output: a render-list keyed by AG-UI event type + control-class items
  - Update useHub reducer: flatten EventFrame.payload[] into buffer entries
    keyed by (jsonl_offset, event_index); dedup remains by jsonl_offset
  - Update history reducer: same flattening for HistoryEvent.payload[]
  - Add packages/pwa/src/lib/view-helpers.ts:
      * toolStatusFromResult(ev) reads ev.rawEvent?.is_error first,
        falls back to content heuristic
      * formatDuration(start, end), riskFromToolName(name)
  - Rewrite the 11 cards in bucket (a) to take AGUIEvent props
  - Delete TaskCreatedCard.tsx, TaskCompletedCard.tsx, IdleWaitingCard.tsx
    and their references in demo/DemoApp.tsx, types.ts, renderTimelineItem.tsx
  - Do NOT touch task_completed / idle control-class frames or their
    consumers (router.ts, useHub completedCounts / push prefs)
  - Tests: bun test packages/pwa/ , bun test e2e-real/

Phase 3 — graduation fixtures + Codex (parallel)
  - Capture real-data JSONL tapes covering: compact, subagent, batch,
    concurrent-tool-calls (multi-block rows — direct test for decision #3
    payload: AGUIEvent[]), malformed rows, run-vs-tool errors,
    long reasoning, multi-RUN session
  - Extend round-trip suite with new tapes; fix from-claude-code.ts as needed
  - (When ready) packages/daemon/src/adapters/codex.ts:
      consume `codex exec --json` JSONL, emit AGUIEvent[],
      preserve is_error equivalent on rawEvent
      daemon CLI flag --agent-kind={claude|codex}
```

No feature flag, no shadow mode, no observation period. If a phase breaks production usage, `git revert` the phase commit.

## 8. Out of Scope (v1)

- `tool_status` / `is_error` convention (deferred — task #9)
- AG-UI Interrupt/Resume migration of permissions (deferred — task #8, blocked on SDK support)
- Codex / Gemini / OpenHands adapters (phase 3, on-demand)
- Runtime zod validation on daemon→hub boundary (optional, can land later)
- Bundling AG-UI runtime into PWA (explicitly avoided)
- Touching `permission_request` / `permission_resolved` / `chat_send` / `start_session` frames

## 9. Open Questions / Deferred Tasks

- **Task #8 (deferred)**: AG-UI protocol-level docs describe interrupt as `RUN_FINISHED.outcome.type = "interrupt"` + `RunAgentInput.resume`; `@ag-ui/core@0.0.53` does **not** yet expose this in its `EventType` enum. When the SDK surfaces the typed shape (or we choose to encode the `outcome` variant ourselves against the protocol doc), migrate the PWA permission flow off control-class frames into native AG-UI HITL events and remove the duplicate path.
- **Task #9 (deferred)**: If the v1 PWA-side tool-failure resolution (rawEvent → heuristic) proves unreliable once non-Claude adapters land, introduce either a single `CUSTOM { name: "cc-remote.tool_status" }` event or a project extension to `TOOL_CALL_RESULT`.
- **Phase-3 fixture suite**: required tape categories listed above; absence not blocking phase 1/2 but blocking "AG-UI adoption complete" tag.

## 10. References

- Spike code: `packages/proto/src/agui/` (uncommitted at design time; phase 1 promotes)
- Spike tests: `packages/proto/tests/agui/round-trip.test.ts`
- AG-UI events: <https://docs.ag-ui.com/sdk/js/core/events>
- Claude Code headless JSONL: <https://code.claude.com/docs/en/headless>
- Codex non-interactive JSON: <https://developers.openai.com/codex/noninteractive>
- Existing TimelineEvent type (to be retired): `packages/pwa/src/screens/timeline/types.ts`
- Existing merger (to be rewritten): `packages/pwa/src/lib/timeline.ts`
