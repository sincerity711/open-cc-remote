# Thinking Collapse + Elapsed — Implementation Plan

> **Spec:** `docs/superpowers/specs/2026-06-07-thinking-collapse-design.md`
> **TODO ref:** AionUi 借鉴 6 项 — item #4
> **Reference impl:** `AionUi/.../MessageThinking.tsx` (icon family, auto-collapse, 1Hz timer, auto-scroll body)

**Goal:** Replace the naïve 12-line `REASONING_MESSAGE_CHUNK` render branch in `renderTimelineItem.tsx` with a collapsible `ReasoningCard` that:
- shows a spinner + live elapsed timer while the model is still thinking,
- auto-collapses to a `Brain` summary the moment any "real" successor (text / tool / permission / run-error / raw) appears in the timeline,
- supports manual click-to-toggle in both states.

**Architecture:** "Done" is a *render-time* property of a reasoning item — derived from the merged `RenderItem[]` by a single backward pass. No proto change, no daemon change, no hub change. A `Map<string, "active"|"done">` is computed once in `SessionTimeline` (`useMemo`) and threaded through `renderTimelineGroup` → `renderTimelineItem` → `renderAgUi` → `<ReasoningCard status=…>`.

**Tech Stack:** React 18, TypeScript, Tailwind tokens, `lucide-react` icons (`Loader2`, `Brain`, `ChevronRight`), `bun:test` + `renderToStaticMarkup` for SSR-style tests.

---

## File Map

**Create:**
- `packages/pwa/src/lib/reasoning-status.ts` — `computeReasoningStatus`, `ReasoningStatus` type
- `packages/pwa/src/lib/reasoning-status.test.ts` — pure-function unit tests
- `packages/pwa/src/screens/timeline/ReasoningCard.tsx` — collapsible card component (~80 lines)
- `packages/pwa/src/screens/timeline/ReasoningCard.test.tsx` — SSR snapshot tests for active/done branches

**Modify:**
- `packages/pwa/src/screens/timeline/renderTimelineItem.tsx` — REASONING_MESSAGE_CHUNK case delegates to `<ReasoningCard>`; thread optional `reasoningStatus` Map
- `packages/pwa/src/screens/timeline/renderTimelineGroup.tsx` — forward optional `reasoningStatus` Map
- `packages/pwa/src/screens/timeline/SessionTimeline.tsx` — compute Map via `useMemo`, pass to `renderTimelineGroup`

**Untouched:** `packages/proto/*`, `packages/daemon/*`, `packages/hub/*`, `packages/plugin/*`, `mergeTimeline`, `groupTimelineItems`, all other render branches, DemoApp call sites (default to `"active"` keeps them green).

---

## Task 1 — `computeReasoningStatus` selector

**Files:**
- Create: `packages/pwa/src/lib/reasoning-status.ts`
- Create: `packages/pwa/src/lib/reasoning-status.test.ts`

Pure function: `(items: RenderItem[]) => Map<string, "active" | "done">`.

Algorithm — single reverse pass:

```
seenFlipper = false
for item in items.reverse():
  if item is reasoning agui:
    map.set(item.id, seenFlipper ? "done" : "active")
  else if isFlipper(item):
    seenFlipper = true
```

`isFlipper` returns true for: `tag === "tool"`, `tag === "permission-resolved"`, or `tag === "agui"` whose event type is `TEXT_MESSAGE_CHUNK` / `RUN_ERROR` / `RAW`. FSM markers (`RUN_STARTED`, `RUN_FINISHED`), `ACTIVITY_*`, `STATE_DELTA`, and other `REASONING_MESSAGE_CHUNK` items do NOT flip status.

Tests cover: empty input, single reasoning, reasoning→text, reasoning→RUN_FINISHED only (still active), reasoning→reasoning→text (both done), reasoning→tool→reasoning (first done / second active).

---

## Task 2 — `ReasoningCard` component

**Files:**
- Create: `packages/pwa/src/screens/timeline/ReasoningCard.tsx`
- Create: `packages/pwa/src/screens/timeline/ReasoningCard.test.tsx`

Props: `{ event: ReasoningMessageChunkEvent; ts: number; status: ReasoningStatus; startedAt: number }`.

Internal state:
- `expanded: boolean` — initialized from `status === "active"`.
- `elapsedMs: number` — initialized from `Date.now() - startedAt` (clamped ≥0). Updated by a `setInterval(1000)` while `status === "active"`; cleared on cleanup or transition to `"done"`.

Effects:
1. **Auto-collapse on done** — `useEffect(() => { if (status === "done") setExpanded(false) }, [status])`. Triggers only on the active→done transition since `status` is the dep; subsequent click-to-toggle is preserved.
2. **Elapsed timer** — `useEffect` keyed on `[status, startedAt]`. While active, recompute on each tick = `Date.now() - startedAtRef.current`. Cleared on cleanup AND when `status === "done"`.
3. **Auto-scroll body** — `useEffect(() => { if (status === "active" && expanded && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight }, [event.delta, status, expanded])`. Reachable only if daemon ever streams multi-chunk reasoning (today: no-op).

Header (button, full-width):
- Icon chip — same border + background as `CatalogHeader`'s `tone="default"` chip. Icon: `Loader2` w/ `animate-spin` while active, `Brain` when done.
- Title: `Thinking · Ns` while active / `Thought · Nm Ss` when done. `formatDuration` helper local to this file.
- Trailing `ChevronRight` w/ `rotate-90` when expanded.

Body (when `expanded`):
- `<pre className="whitespace-pre-wrap text-sm leading-5">…</pre>` inside a scroll container `bg-muted text-muted-foreground border-l-2 border-l-border/80 mt-2 max-h-60 overflow-auto rounded-md p-2.5`. Falls back to `(no reasoning text)` if `event.delta` is empty.

`formatDuration(ms)` — local helper. `<60s → "Ns"`, `<3600s → "Nm Ss"`, else `"Hh Mm Ss"`. English only.

Tests (SSR — `bun:test` lacks JSDOM, so we test rendered markup for the active/done snapshot branches and visible duration text):
- Active branch (`startedAt = Date.now()`): contains `animate-spin`, "Thinking", body text visible.
- Done branch (`startedAt = Date.now() - 5000`): contains `Brain`-icon class, "Thought", body NOT in markup, "5s" visible.
- Done with `Date.now() - 83000`: visible text contains `1m 23s`.

Click-toggle / live timer behavior aren't covered by SSR; rely on the helper unit tests for elapsed math + manual visual review for click handler.

---

## Task 3 — Wire status Map through render dispatch

**Files (modify):**
- `packages/pwa/src/screens/timeline/renderTimelineItem.tsx`
- `packages/pwa/src/screens/timeline/renderTimelineGroup.tsx`
- `packages/pwa/src/screens/timeline/SessionTimeline.tsx`

1. `renderTimelineItem(item, reasoningStatus?)` — second param is optional `Map<string, ReasoningStatus>`. `renderAgUi` gets a `status: ReasoningStatus` argument (default `"active"`) for the `REASONING_MESSAGE_CHUNK` branch only.
2. `renderTimelineGroup(group, reasoningStatus?)` — forward to `renderTimelineItem`.
3. `SessionTimeline`: `const reasoningStatus = useMemo(() => computeReasoningStatus(items), [items])`; pass to `groups.map((g) => renderTimelineGroup(g, reasoningStatus))`.

DemoApp's existing call sites (`renderTimelineGroup({...})` without a second arg) keep working because the param is optional and the default `"active"` preserves the original visual.

---

## Task 4 — Tests + typecheck + commit

- `bun test packages/pwa/` passes.
- `tsc --noEmit` from the package directory passes.
- `<CatalogHeader title="Reasoning" />` literal is gone from `renderTimelineItem.tsx`.
- One commit: `feat(pwa): collapsible reasoning card with elapsed timer (#4)`.

---

## Out of scope (per spec)

- Persisting expanded state across reload.
- Markdown rendering inside the body.
- Multi-chunk reasoning streaming UI (auto-scroll branch implemented but unreachable today).
- `subject` field rendering.
- Tab-background timer pause.

## Acceptance

1. While the latest reasoning event has no real successor, its card shows `Loader2` + `Thinking · Ns`, body expanded, ticking every second.
2. As soon as a text/tool/permission/run-error item appears after it, the card flips to `Brain` + `Thought · …`, body collapsed.
3. Click toggles `expanded` regardless of status.
4. `<CatalogHeader title="Reasoning" />` literal is gone from `renderTimelineItem.tsx`.
5. All existing PWA tests pass; two new test files added.
