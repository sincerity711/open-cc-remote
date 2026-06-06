# Resolved Permission / Ask Cards — Timeline Receipts

**Status**: draft, awaiting user review
**Origin**: `docs/TODO.md` "AionUi 借鉴 6 项" item #5 — *Permission/Ask 答完回执*.
**Related**: `packages/pwa/src/screens/primitives/InlinePermissionCard.tsx`, `packages/pwa/src/screens/AskQuestionSurface.tsx`, `packages/pwa/src/lib/timeline.ts`, `packages/pwa/src/screens/timeline/renderTimelineItem.tsx`.

---

## Problem

When the user resolves an `InlinePermissionCard` (Allow / Deny) or submits an `AskQuestionSurface`, the live prompt UI **vanishes without leaving a record**. AionUi's equivalent shows a green "✓ banner" so the user can scroll back and see *what they decided*. Today:

- `InlinePermissionCard` is unmounted by `SessionView` the moment `pendingPermissions[request_id]` clears (resolve from any device).
- `renderTimelineItem.tsx:34` already has a `permission-resolved` case, but it renders a single-line `CatalogHeader` ("Permission granted" / "denied" / "expired") — no command, no decision metadata, no relative time. It is a marker, not a receipt.
- The Ask path renders **nothing** in the timeline post-answer. `mergeTimeline` (`packages/pwa/src/lib/timeline.ts:111-124`) only emits `permission-resolved`; there is no `ask-question-resolved` RenderItem variant at all.

Net: the user has no scrollable record of past permission/ask decisions. The receipt is the missing UX piece.

## Decision

Render two new presentational cards at resolution sites in the timeline. **No state-machine changes** to the live cards (no fade-out, no setTimeout linger, no in-place "you decided" banner). The "answered" feedback comes from a **distinct ResolvedCard rendered at the resolution point in the timeline** — visually settled (success/error tone, ✓/✗ icon), reusing the existing `tokenizeCommand` so the historical decision shows the same code rendering as the live prompt.

`AskQuestionSurface` stays modal — small-screen PWA wins. On answer/close, render a `ResolvedAskQuestionCard` in the timeline.

## Visual contract

Both cards mirror the source surface in a "settled" register:

- **Tone**: `success-subtle` (green border-tint) for `allow` / `answered`; `danger-subtle` for `deny`; muted for `expired` / `terminal` / `session_unknown` / `no_pwa`.
- **Header pill**: small uppercase label — `ALLOWED` / `DENIED` / `EXPIRED` / `TERMINAL` / `ANSWERED` / `EXPIRED` / `CANCELED` — replacing the warning `PERMISSION` / `QUESTION` pill of the live cards.
- **Icon**: `Check` (allow / answered) or `X` (deny) or muted clock (expired). Distinct from the live `ShieldAlert` / `HelpCircle` so a glance distinguishes live vs settled.
- **Body**: same tokenized code block (Permission) or question/answer text (Ask). Same monospace, same `bg-code` token. Identical token classes from `tokenizeCommand`.
- **Decision row**: `you allowed this · 3s ago` (relative timestamp, updates on rerender via the same hook the timeline already uses for tool timestamps).
- **No action buttons** — the card is immutable. Out of scope: edit/undo.

## Components

```
ResolvedPermissionCard.tsx
  Props: { resolved: PwaPermissionResolved, request: PwaPermissionRequest | null }
  - request may be null on cross-device / replay (see "Request lookup" below)
  - Header: pill ("ALLOWED" / "DENIED" / "EXPIRED" / "TERMINAL"), tool name, ✓/✗ icon, req id short
  - Body: tokenized code block via tokenizeCommand if request != null;
          else "(command not in history)" placeholder (muted, italic)
  - Footer: relative timestamp + "via <decided_via>" if non-default

ResolvedAskQuestionCard.tsx
  Props: { resolved: PwaAskUserQuestionResolved, request: PwaAskUserQuestionRequest | null, answers: (string | null)[] | null }
  - Header: pill ("ANSWERED" / "EXPIRED" / "CANCELED"), question text truncated, ✓/✗ icon, req id short
  - Body: per question, the option list with the chosen option highlighted
          (mirrors AskQuestionSurface idiom). If answers == null (cross-device / no local
          submission), show "(answered on another device)" placeholder.
  - Footer: relative timestamp
```

Both mount with a single CSS opacity-in transition (already in stylesheet for cards). No motion polish beyond that.

## Storage — request and answer lookup

**Wrinkle 1: pendingPermissions is cleared on resolve.** The reducer at `useHub.ts:443-454` deletes `pendingPermissions[request_id]` the moment a `permission_resolved` arrives. Walking `events` does not help — `BufferedEvent.event` only carries AG-UI events, not protocol frames. Same problem on the Ask side at `useHub.ts:460-468`.

→ Add a **sticky cache** per kind, populated in the `*_request` reducer branch and **never cleared by resolve**. Bounded by an LRU (last 64 entries per session) so memory stays flat across long sessions. Keyed by `request_id`.

```ts
// In HubState (extend, do not modify existing slices):
permissionRequestHistory: Record<string, PwaPermissionRequest>      // LRU 64
askQuestionRequestHistory: Record<string, PwaAskUserQuestionRequest> // LRU 64
askQuestionAnswerHistory: Record<string, (string | null)[]>          // LRU 64
```

**Wrinkle 2: `PwaAskUserQuestionResolved` does not carry the chosen answer** — only `resolution: "answered" | "expired" | ...`. The user's local submission *did* carry answers (`PwaToHubAskUserQuestionAnswer.answers`). Capture them into `askQuestionAnswerHistory[request_id]` when the PWA dispatches `outbound_ask_answer`. Cross-device path leaves the cache empty → card renders the placeholder.

Out of scope: extending the proto so `ask_user_question_resolved` echoes the answers (would let cross-device PWAs see the chosen option). Defer until a user actually asks.

**Helpers** (`packages/pwa/src/lib/permission-history.ts`):

```ts
export function findPermissionRequest(
  history: Record<string, PwaPermissionRequest>,
  requestId: string,
): PwaPermissionRequest | null

export function findAskQuestionRequest(
  history: Record<string, PwaAskUserQuestionRequest>,
  requestId: string,
): PwaAskUserQuestionRequest | null

export function findAskQuestionAnswers(
  history: Record<string, (string | null)[]>,
  requestId: string,
): (string | null)[] | null
```

Each is a one-line lookup; the helper layer exists so the timeline renderer doesn't reach into `HubState` directly and so unit tests don't need to construct a full hub.

## File-by-file changes

| File | Change |
|---|---|
| `packages/pwa/src/hooks/useHub.ts` | Extend `HubState` with three new history maps; populate in `permission_request` / `ask_user_question_request` reducer branches; populate `askQuestionAnswerHistory` in the `outbound_ask_answer` action. Bounded LRU eviction (last 64). |
| `packages/pwa/src/lib/permission-history.ts` | NEW — three lookup helpers + LRU insert helper. |
| `packages/pwa/src/lib/permission-history.test.ts` | NEW — round-trip insert/lookup, LRU eviction, missing-key returns null. |
| `packages/pwa/src/screens/timeline/types.ts` | Add `ask-question-resolved` variant to `RenderItem` union mirroring `permission-resolved`. |
| `packages/pwa/src/lib/timeline.ts` | Extend `mergeTimeline` to also emit an `ask-question-resolved` `RenderItem` from a new `args.askResolved: PwaAskUserQuestionResolved[]` input. Same `rank: 3` tie-break. |
| `packages/pwa/src/screens/timeline/ResolvedPermissionCard.tsx` | NEW — ~120 lines. Tokenized code block via `tokenizeCommand`; status pill + tone selection. |
| `packages/pwa/src/screens/timeline/ResolvedAskQuestionCard.tsx` | NEW — ~80 lines. Question + chosen-option highlight. |
| `packages/pwa/src/screens/timeline/renderTimelineItem.tsx` | Replace minimal `permission-resolved` body with `<ResolvedPermissionCard request={...} resolved={...} />`. Add `ask-question-resolved` case. Both need `request`/`answers` lookup; pass through props from `SessionView` (no React context — keep dataflow explicit). |
| `packages/pwa/src/screens/SessionView.tsx` | Pass `permissionRequestHistory`, `askQuestionRequestHistory`, `askQuestionAnswerHistory` from hub state into the timeline renderer. Pass `askResolved` collection into `mergeTimeline`. |
| `packages/pwa/src/screens/timeline/ResolvedPermissionCard.test.tsx` | NEW — render with matching request → tokenized code visible; without request → placeholder; status pill correct per decision; relative time updates. |
| `packages/pwa/src/screens/timeline/ResolvedAskQuestionCard.test.tsx` | NEW — same coverage on the Ask side. |

Net: ~5 new files, ~5 modified, no proto / daemon / hub changes.

## Migration

Pure PWA UI change. No proto / daemon / hub impact. Old PWA still gets resolved frames; just renders the existing minimal marker. New PWA against old hub: unaffected (no protocol delta). No deployment ordering constraint.

## Out of scope

- **Editing** the historical decision (immutable).
- **Re-prompting** after `expired`.
- **Undo / cross-device duplicate handling** — covered by the existing reducer; `permission_resolved` is idempotent.
- **Animation polish** beyond a CSS opacity-in-on-mount.
- **Filter / search** the resolved history.
- **Collapsing old resolved cards** after N — defer; matches existing scroll model.
- **Extending `PwaAskUserQuestionResolved`** to carry answers (so cross-device PWAs can see the choice). Note as a follow-up; not blocking.

## Testing strategy

Unit:

- `permission-history.test.ts`: insert / lookup / LRU eviction at 64.
- `ResolvedPermissionCard.test.tsx`: matching-request path renders tokenized command; null-request path renders placeholder; each of `allow|deny|expired|terminal` produces the right pill + tone; relative timestamp updates on rerender.
- `ResolvedAskQuestionCard.test.tsx`: matching-request + answers path highlights chosen option; null-request path renders placeholder; each of `answered|expired|session_unknown|no_pwa` produces the right pill.
- `timeline.test.ts`: extend with `ask-question-resolved` emit cases — same `rank: 3` ordering invariants.
- `useHub.test.ts`: assert sticky-history population on `*_request`; assert history is **not** cleared on `*_resolved`; assert `outbound_ask_answer` populates `askQuestionAnswerHistory`.

Integration / SSR:

- Existing SSR snapshot test for `SessionView` — extend the fixture to include one resolved permission and one resolved Ask; snapshot must remain stable across reruns.

Manual / e2e:

- `e2e-real/tests/14-permission-relay.test.ts` — extend final assertion: after Allow click, a card with `data-testid="resolved-permission-card"` appears at the same scroll position with the same `args_summary`.
- `e2e-real/tests/23-ask-user-question.test.ts` — extend: after submit, a card with `data-testid="resolved-ask-question-card"` appears containing the chosen option.

## Acceptance criteria

1. After clicking Allow on `InlinePermissionCard`, within ~50ms the live card disappears and a `ResolvedPermissionCard` appears at the same scroll position with the same command tokenized + ✓ "Allowed".
2. After answering an `AskQuestionSurface`, a `ResolvedAskQuestionCard` appears in the timeline with the chosen answer highlighted within its option list.
3. Cross-device path: a `permission_resolved` / `ask_user_question_resolved` arriving on a PWA that never saw the corresponding `*_request` (history cache empty) renders the card with the "(command not in history)" / "(answered on another device)" placeholder — no crash, no missing visual.
4. SSR snapshot tests pass.
5. Existing `bun test packages/pwa` continues green; +5 new test files green.

## Open questions

- **Show full options + highlight chosen, or just the chosen text?** Default: full options with chosen highlighted (mirrors `AskQuestionSurface`'s own idiom; cost is ~10 lines of JSX). Flip to "just the chosen text" if the question carries 6+ options and the card becomes scroll-heavy — defer that decision until real questions test it.
- **LRU bound at 64 — too low / too high?** Sessions with >64 permission prompts are pathological; we'll evict oldest first and old `ResolvedPermissionCard` instances fall back to the placeholder body. Reasonable default; revisit if a real session blows past it.
- **Should `decided_via` (e.g. `pwa`, `tui`, `expired`) be surfaced in the footer?** Default: yes — small muted text, e.g. "decided via PWA". One line, one i18n string. Skip if it adds visual noise.
