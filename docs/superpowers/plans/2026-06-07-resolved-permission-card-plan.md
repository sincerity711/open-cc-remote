# Resolved Permission / Ask Cards — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** Render a settled receipt card (`ResolvedPermissionCard`, `ResolvedAskQuestionCard`) at the resolution point in the timeline, mirroring the live `InlinePermissionCard` / `AskQuestionSurface` body so the user can scroll back and see *what they decided*.

**Reference:** spec at `docs/superpowers/specs/2026-06-07-resolved-permission-card-design.md`.

**Branch:** `feat/resolved-cards` (off `b944808`).

---

## Pre-flight verification

Before editing, confirm the following anchors still match the spec snapshot (verified against `b944808`):

- `packages/pwa/src/hooks/useHub.ts:88` — `pendingPermissions: Record<string, PwaPermissionRequest>`.
- `packages/pwa/src/hooks/useHub.ts:95` — `pendingQuestions: Record<string, PwaAskUserQuestionRequest>`.
- `packages/pwa/src/hooks/useHub.ts:438-454` — `permission_request` adds, `permission_resolved` deletes from `pendingPermissions`. **Frame is then dropped — not retained anywhere.**
- `packages/pwa/src/hooks/useHub.ts:455-469` — same pattern for ask requests.
- `packages/pwa/src/hooks/useHub.ts:154` — `outbound_ask_answer` action shape (no `answers` field today; we will add one).
- `packages/pwa/src/hooks/useHub.ts:759-781` — `sendAskAnswer` dispatches `outbound_ask_answer`.
- `packages/pwa/src/hooks/useSessionTimeline.ts:76-78` — `resolved` is hardcoded `[]`. We must source it from a new hub-state slice.
- `packages/pwa/src/lib/timeline.ts:43,111-124` — `mergeTimeline` signature + `permission-resolved` emit branch.
- `packages/pwa/src/screens/timeline/types.ts:33` — `RenderItem` union with `permission-resolved`.
- `packages/pwa/src/screens/timeline/renderTimelineItem.tsx:34-53` — minimal `permission-resolved` case.
- `packages/proto/src/frames.ts:490,500,624,633,642` — request/resolved/answer frame shapes.

**Stop and report** if any of the above is materially different.

---

## File Map

**Create:**
- `packages/pwa/src/lib/permission-history.ts` — sticky LRU helpers + insert helper.
- `packages/pwa/src/lib/permission-history.test.ts` — unit tests for LRU + lookups.
- `packages/pwa/src/screens/timeline/ResolvedPermissionCard.tsx` — settled permission card.
- `packages/pwa/src/screens/timeline/ResolvedAskQuestionCard.tsx` — settled ask card.
- `packages/pwa/tests/ResolvedPermissionCard.test.tsx` — SSR coverage.
- `packages/pwa/tests/ResolvedAskQuestionCard.test.tsx` — SSR coverage.

**Modify:**
- `packages/pwa/src/hooks/useHub.ts` — extend `HubState`, reducer, `outbound_ask_answer` action shape, `sendAskAnswer`. Add 5 new state fields (3 sticky histories + 2 resolved buffers).
- `packages/pwa/src/lib/timeline.ts` — `mergeTimeline` accepts `askResolved` + emits `ask-question-resolved`.
- `packages/pwa/src/screens/timeline/types.ts` — add `ask-question-resolved` variant.
- `packages/pwa/src/screens/timeline/renderTimelineItem.tsx` — replace stub permission-resolved case; add ask-question-resolved case; thread histories via props.
- `packages/pwa/src/screens/timeline/renderTimelineGroup.tsx` — pass histories through.
- `packages/pwa/src/screens/timeline/SessionTimeline.tsx` — accept histories as props, forward to renderTimelineGroup.
- `packages/pwa/src/screens/SessionView.tsx` — accept + forward histories.
- `packages/pwa/src/RealApp.tsx` — pass histories from `hub` into `SessionView`.
- `packages/pwa/src/hooks/useSessionTimeline.ts` — source `resolved` + `askResolved` arrays from hub state; pass into `mergeTimeline`.
- `packages/pwa/src/lib/timeline.test.ts` — extend with `askResolved` cases.
- `packages/pwa/tests/useHub.test.ts` — add 4 cases (sticky history populated, not cleared on resolve, `outbound_ask_answer` populates `askQuestionAnswerHistory`, LRU eviction at 64).

**Untouched:** `packages/proto`, `packages/daemon`, `packages/hub`, `packages/plugin`. Wrinkle 2 (extending `PwaAskUserQuestionResolved` to carry answers) is **deferred** as per spec §"Out of scope".

---

## Task 1 — `permission-history.ts` LRU helpers

**Files:**
- Create: `packages/pwa/src/lib/permission-history.ts`
- Test: `packages/pwa/src/lib/permission-history.test.ts`

**Step 1 — write failing test**

Cover: `insertWithLru` evicts oldest when bound exceeded; lookup returns `null` for missing key; lookup returns stored value for present key; insert preserves recency on re-set (move-to-end semantics).

**Step 2 — implementation**

```ts
const LRU_MAX = 64;

export function insertWithLru<V>(
  history: Record<string, V>,
  key: string,
  value: V,
  max = LRU_MAX,
): Record<string, V> {
  // Object insertion order is preserved (string keys, ES2015+).
  // Re-set: drop the prior entry to bump key to "newest" position.
  const next = { ...history };
  if (key in next) delete next[key];
  next[key] = value;
  const keys = Object.keys(next);
  if (keys.length <= max) return next;
  // Drop oldest entries until size === max.
  for (let i = 0; i < keys.length - max; i++) delete next[keys[i]!];
  return next;
}

export function findPermissionRequest(history, requestId) { return history[requestId] ?? null; }
export function findAskQuestionRequest(history, requestId) { return history[requestId] ?? null; }
export function findAskQuestionAnswers(history, requestId) { return history[requestId] ?? null; }
```

**Acceptance:**
- 5+ tests pass under `bun test packages/pwa/src/lib/permission-history.test.ts`.
- LRU bound at 64 (per spec §Storage; not 200).

---

## Task 2 — `HubState` extensions + reducer wiring

**Files:**
- Modify: `packages/pwa/src/hooks/useHub.ts`
- Test: `packages/pwa/tests/useHub.test.ts`

**Step 1 — write failing tests**

Add to `useHub.test.ts`:

1. `permission_request` populates `permissionRequestHistory[request_id]` AND `pendingPermissions[request_id]`.
2. `permission_resolved` deletes `pendingPermissions[request_id]` but **leaves `permissionRequestHistory[request_id]` intact**.
3. `permission_resolved` appends the resolved frame to `permissionResolutions[eventKey]`.
4. `ask_user_question_request` populates `askQuestionRequestHistory[request_id]`.
5. `outbound_ask_answer` (with new `answers` payload) populates `askQuestionAnswerHistory[request_id]`.
6. LRU bound: 65th insert evicts the 1st entry from `permissionRequestHistory`.

**Step 2 — implementation**

In `HubState`:

```ts
permissionRequestHistory: Record<string, PwaPermissionRequest>;       // LRU 64
askQuestionRequestHistory: Record<string, PwaAskUserQuestionRequest>; // LRU 64
askQuestionAnswerHistory: Record<string, (string | null)[]>;          // LRU 64
permissionResolutions: Record<string, PwaPermissionResolved[]>;       // per eventKey, capped 64
askQuestionResolutions: Record<string, PwaAskUserQuestionResolved[]>; // per eventKey, capped 64
```

`initialHubState()` adds `: {}` for all five.

In `permission_request` branch — also `insertWithLru(prev.permissionRequestHistory, frame.request_id, frame)`.
In `permission_resolved` branch — also append `frame` to `permissionResolutions[eventKey]` (cap last 64, immutable copy). **Do not** clear history.
In `ask_user_question_request` branch — also `insertWithLru(prev.askQuestionRequestHistory, ...)`.
In `ask_user_question_resolved` branch — append to `askQuestionResolutions[eventKey]` (cap 64).

In action union, change:
```ts
| { type: "outbound_ask_answer"; daemon_id; session_id; request_id; started_at; answers: (string | null)[] }
```
In `outbound_ask_answer` reducer branch — also `insertWithLru(prev.askQuestionAnswerHistory, action.request_id, action.answers)`.
In `sendAskAnswer` (line ~759) — pass `answers` into the dispatched action.

**Acceptance:**
- All new useHub.test.ts cases green.
- Existing useHub.test.ts cases remain green (resolved still clears `pendingPermissions`).

---

## Task 3 — `mergeTimeline` extension + `RenderItem` variant

**Files:**
- Modify: `packages/pwa/src/lib/timeline.ts`
- Modify: `packages/pwa/src/screens/timeline/types.ts`
- Test: `packages/pwa/src/lib/timeline.test.ts`

**Step 1 — failing test**

`mergeTimeline` with one `askResolved` entry emits an `ask-question-resolved` RenderItem with `rank: 3`, `id: \`ask-resolved:${request_id}\``.

**Step 2 — implementation**

```ts
export interface MergeTimelineArgs {
  events: BufferedEvent[];
  resolved: PwaPermissionResolved[];
  askResolved: PwaAskUserQuestionResolved[];
}
```
Add a parallel emit loop after the existing `resolved` loop. Same `rank: 3`, same `Number.MAX_SAFE_INTEGER` offset. Add `ts` field same way.

In `RenderItem`:
```ts
| { tag: "ask-question-resolved"; id: string; ts: number; resolved: PwaAskUserQuestionResolved }
```

**Acceptance:**
- New test green.
- Existing 4 timeline tests still green (with `askResolved: []`).

---

## Task 4 — `ResolvedPermissionCard` + `ResolvedAskQuestionCard`

**Files:**
- Create: `packages/pwa/src/screens/timeline/ResolvedPermissionCard.tsx`
- Create: `packages/pwa/src/screens/timeline/ResolvedAskQuestionCard.tsx`
- Test: `packages/pwa/tests/ResolvedPermissionCard.test.tsx`
- Test: `packages/pwa/tests/ResolvedAskQuestionCard.test.tsx`

**ResolvedPermissionCard contract (~120 lines):**

Props:
```ts
{ resolved: PwaPermissionResolved; request: PwaPermissionRequest | null }
```

- Pill: `ALLOWED` / `DENIED` / `EXPIRED` / `TERMINAL`.
- Icon: `Check` (allow), `X` (deny), `Clock` (expired/terminal).
- Tone: `success-subtle` for allow, `danger-subtle` for deny, muted/border-border for expired/terminal.
- Body: tokenized code block via `tokenizeCommand` (mirroring `InlinePermissionCard.tsx:106-120`) when `request != null`. Else `<p>(command not in history)</p>` muted italic.
- Decision row: muted text, `decided via {decided_via}` if non-default.
- `data-testid="resolved-permission-card"`.

**ResolvedAskQuestionCard contract (~80 lines):**

Props:
```ts
{ resolved: PwaAskUserQuestionResolved; request: PwaAskUserQuestionRequest | null; answers: (string | null)[] | null }
```

- Pill: `ANSWERED` / `EXPIRED` / `CANCELED` / `NO PWA` (mapped from `resolution`).
- Icon: `Check` / `X` / `Clock`.
- Body if `request != null`: per question, list options; the option whose `label === answers?.[qIdx]` gets a "selected" border; else default border. If `answers == null`, show "(answered on another device)" muted italic placeholder.
- If `request == null`: show "(question not in history)" placeholder.
- `data-testid="resolved-ask-question-card"`.

**Tests (SSR-only via `renderToStaticMarkup`):**

`ResolvedPermissionCard.test.tsx`:
1. With request + allow → renders `ALLOWED` pill, command text via tokens.
2. With request + deny → renders `DENIED` pill, danger tone.
3. Without request → renders "(command not in history)" placeholder.
4. Decision = "expired" → renders `EXPIRED` pill, no command body assertion.

`ResolvedAskQuestionCard.test.tsx`:
1. With request + answers → renders question + chosen option highlighted.
2. With request, `answers={null}` (cross-device) → placeholder "(answered on another device)".
3. Without request → "(question not in history)".

**Acceptance:** all 7 SSR tests pass.

---

## Task 5 — Wire histories through to renderer

**Files:**
- Modify: `packages/pwa/src/hooks/useSessionTimeline.ts`
- Modify: `packages/pwa/src/screens/timeline/renderTimelineItem.tsx`
- Modify: `packages/pwa/src/screens/timeline/renderTimelineGroup.tsx`
- Modify: `packages/pwa/src/screens/timeline/SessionTimeline.tsx`
- Modify: `packages/pwa/src/screens/SessionView.tsx`
- Modify: `packages/pwa/src/RealApp.tsx`

**Strategy:**

`useSessionTimeline.ts:76-78` — replace the hardcoded `resolved: []` with `hub.permissionResolutions[k] ?? []` and source `askResolved` from `hub.askQuestionResolutions[k] ?? []`. Pass into `mergeTimeline`.

`renderTimelineItem.tsx` — change signature:
```ts
export interface RenderTimelineItemContext {
  permissionRequestHistory: Record<string, PwaPermissionRequest>;
  askQuestionRequestHistory: Record<string, PwaAskUserQuestionRequest>;
  askQuestionAnswerHistory: Record<string, (string | null)[]>;
}
export function renderTimelineItem(item: RenderItem, ctx: RenderTimelineItemContext): React.ReactElement
```

Replace minimal `permission-resolved` case with `<ResolvedPermissionCard resolved={item.resolved} request={ctx.permissionRequestHistory[item.resolved.request_id] ?? null} />`. Add new `ask-question-resolved` case using `ctx.askQuestionRequestHistory` + `ctx.askQuestionAnswerHistory`.

Thread `ctx` through `renderTimelineGroup → SessionTimeline → SessionView → RealApp`.

`RealApp.tsx`: pull the three histories off `hub` and forward to `SessionView`.

**Acceptance:**
- Typecheck green.
- E2E test fixtures continue to work (no live tests added in this task).

---

## Task 6 — Final verification

- `bun test packages/pwa/` — all green, 7 new test files contributing ≥18 new tests.
- `tsc --noEmit` (or pwa typecheck script) — green.
- `git diff --stat` — only files in this plan's File Map.
- Commit: `feat(pwa): resolved permission/ask cards with sticky history (#5)` — includes spec + this plan.
