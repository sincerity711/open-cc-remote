# Permission UX & Notification Redesign — Design Spec

> **Status**: design approved 2026-05-29 — pending implementation plan via writing-plans skill.
> **Authors**: Ciro Xu (driver) · Claude (assistant)
> **Visual prototype**: `/tmp/cc-remote-redesign-prototype.html` (interactive, single-file inline React) — captures the four key states under `/tmp/cc-remote-redesign-shots/{01..06}*.png`.

## 1 · Why

The PWA today routes Claude Code permission requests through three app-level surfaces:

1. **Top-of-home banner** that picks the first pending request across *all* sessions (`RealApp.tsx:143–153 → AppShell topPendingPreview`).
2. **Bell icon** in the AppShell header + DesktopNav rail with a global `pendingApprovalsCount` badge.
3. **Full-screen `PermissionSurface` modal** opened by either banner *Review* button or Bell click, paginated through *every* daemon's pending queue via `usePermissionQueue`.

Two things make this wrong now:

- **It's app-level, not session-level.** When session B sneezes, session A's user gets a modal slammed over their timeline. The recent `7114777 pwa: only render AskQuestionSurface for the selected session` commit established the opposite — and correct — pattern for AskUserQuestion. Permission requests should follow.
- **The Bell is the entire "notification center"** and only ever shows permissions. Users (correctly) read the bell icon as a generic notification feed and feel something is broken when nothing else lands there. The cheapest fix is to remove it; building a richer feed is out of scope for a tool that already surfaces task state directly on each session card.

Push notifications are over-broad in a related way: hub registers four topics (`permission` / `offline` / `completed` / `idle`) but `completed` and `idle` fire on the same end-of-turn event ~3s apart, and `offline` rarely matters in the local-pairing model. Two of the four are noise.

## 2 · Goals & non-goals

**Goals**
- Permission UI lives inside the session it belongs to. Other sessions are not interrupted.
- Home `SessionRow` is the single source of truth for "this session needs attention" — already implemented via `border-warning/45` + the `permission needed (Bash)` activity text in `daemonViewModel.ts:108-110`.
- One pending permission renders as a prominent inline card directly in the session timeline, allow/deny inline, no modal.
- Push topics reduce to {permission, idle}.
- Settings drawer reflects the simplified push topic set.

**Non-goals**
- No new "rich notification feed" component to replace the deleted Bell. Sessions cards already say it all.
- No batched / cross-session "approve all" power-user shortcut. Multi-session approval is rare and not a current pain.
- DB schema migration for the dropped push topics. We retain the `preferences` JSON shape for forward-compat; old `completed:true` / `offline:true` keys become silently dead after the dispatch path is removed.
- Re-skinning the AskUserQuestion surface — already session-bound by 7114777 and out of scope.

## 3 · Architecture overview

The data flow is unchanged. `permission_request` frames still flow `daemon → hub → PWA` and land in `pendingPermissions` keyed on `request_id`. The redesign is consumer-side only:

```
permission_request frame
  └─ reducer: pendingPermissions[request_id] = req      (unchanged)
      ├─ SessionView (selected only)                    (NEW: render InlinePermissionCard)
      └─ HomeScreen SessionRow (any)                    (existing: border + activity text — visual only tweaks if needed)
```

There is **no proto-level change**, **no daemon change**, and **no hub-side router change** specific to permission. The hub-side change is restricted to push dispatch (§5).

## 4 · PWA changes

### 4.1 · Delete

| File / symbol | Why |
|---|---|
| `packages/pwa/src/hooks/usePermissionQueue.ts` | The cross-session queue + `handledNotice` state machine no longer has a UI to drive |
| `packages/pwa/src/screens/PermissionSurface.tsx` | Full-screen modal goes away |
| `RealApp.tsx:83` `usePermissionQueue` call | dependency removed |
| `RealApp.tsx:84` `pendingApprovalsCount` calc | no badge needs it |
| `RealApp.tsx:86-96` `pendingReply` + `activeRequestId` effect | tied to modal state |
| `RealApp.tsx:143-153` `topPending` + `topPendingPreview` | global banner gone |
| `RealApp.tsx:253-271` `<PermissionSurface>` mount | modal gone |
| `RealApp.tsx:272-...` `permissionQueue.handledNotice` toast | tied to deleted state |
| `AppShell.tsx` Bell `<button>` at L99-111 (mobile header) | nothing left for it to do |
| `AppShell.tsx` `DesktopNav` Bell at L196-208 | same |
| `AppShell.tsx` `pendingApprovalsCount` + `onOpenPermission` props throughout | dead chain |
| `SessionView.tsx:25` `pendingPermissionInThisSession` prop **type** | we keep the prop but **rename + simplify** in §4.2 |

### 4.2 · Add — `InlinePermissionCard` (variant B)

`packages/pwa/src/screens/primitives/InlinePermissionCard.tsx`:

```tsx
export interface InlinePermissionCardProps {
  request: PwaPermissionRequest;
  pendingReply?: PendingCommand;            // shows spinner + disables buttons during in-flight reply
  onDecide(decision: "allow" | "deny"): void;
}
```

Visual contract (matches prototype variant B, design tokens straight from `styles.css`):

- Container: `bg-surface` · `border` color `rgba(217, 119, 6, 0.35)` (warning/35) · `rounded-card` · subtle drop shadow tinted with warning (`0 8px 24px rgba(217, 119, 6, 0.06)`)
- Header row: warning-subtle `Permission` pill (h-22, uppercase tracking) + tool name (`request.tool`) bold + spacer + truncated `request_id` slice 0..8 (mono, muted)
- Code block: `bg-code` (`#0f172a`) · `text-code-foreground` · mono · 12px · padded · displays `$ ${request.args_summary}` verbatim with `white-space: pre-wrap; word-break: break-all` so even very long shell pipelines don't escape the card
- Optional rationale row (only if proto carries it — currently it doesn't, so this is a forward-compat hook): `text-muted-foreground` 12px, prefix `Rationale: ` then `text-foreground` weight 500 body
- Action row, right-aligned: `Deny` ghost button (`btn-secondary`-style — `bg-surface`, `border`, `text-foreground`) + `Allow once` filled `bg-success` button (per recent design conversation phrasing — copy may be tuned during implementation)
- During `pendingReply.status === "pending"`: both buttons disabled, spinner glyph in the active button, banner copy adds `· sending…`
- On cross-device resolution (`pendingPermissions[req.request_id]` disappears from the reducer while card is mounted): card unmounts naturally. **No** "handled by another device" toast — visual disappearance is sufficient signal.

### 4.3 · Modify — `SessionView`

Replace the existing minimal banner block (`SessionView.tsx:136-147`) with the inline card. Skeleton:

```tsx
{pendingPermissionInThisSession && (
  <InlinePermissionCard
    request={pendingPermissionInThisSession}
    pendingReply={pendingPermissionReply}
    onDecide={(decision) => sendPermissionReply(pendingPermissionInThisSession, decision)}
  />
)}
```

The card lives **in the timeline scroll area** at the top, not as a sticky banner above the composer. Reasons:
- Permission is a *conversation event* — putting it inline with the rest of the timeline keeps the user's mental model coherent (events scroll, ephemeral state doesn't).
- When stacking multiple pending permissions in the same session (rare, but possible if Claude fires several tool calls), they line up naturally as a vertical stack.
- The composer's `composerBlocked` flag stays — typing is still disabled until the request is decided.

Prop changes:
- Drop `onOpenPermission: (request_id: string) => void` (no longer needed — no modal to open).
- Add `pendingPermissionReply?: PendingCommand` (already available via `hub.pendingPermissionReplyFor`).
- Add `onSendPermissionReply: (req, decision) => void` (passed from RealApp; thin wrapper around `hub.sendPermissionReply`).

### 4.4 · Modify — `HomeScreen` `SessionRow`

The existing visuals are 80% there. Two targeted polish items:

- The orange left border (`border-warning/45`) is currently 1px — bump to **2px on the left edge only** for waiting state to read more clearly across a list of cards. Other edges stay 1px.
- Move the activity text (`permission needed (Bash)`) up next to the session name on its own row in waiting state — today it's the third line buried under cwd. Visual hierarchy: state chip + permission summary should beat cwd in priority when waiting.

These are bounded JSX-level tweaks in `SessionRow` (`HomeScreen.tsx:333-415`). No new state or props.

### 4.5 · Modify — `SettingsDrawer` push toggles

Two toggles only: `permission`, `idle`. Removing two `<ToggleRow>` entries; copy:
- `permission` → "Permission requests" / "Push when Claude needs your approval"
- `idle` → "Idle" / "Push when Claude finishes a task"

`usePushTopics` hook returns the trimmed topic list — no logic change beyond the trimmed source-of-truth array.

## 5 · Hub changes (push only)

### 5.1 · `packages/hub/src/push-topics.ts`

- Delete `completedTopic` const (id `"completed"`).
- Delete `offlineTopic` const (id `"offline"`).
- `TOPICS` array reduces to `[permissionTopic, idleTopic]`.
- `getTopic("completed")` / `getTopic("offline")` no longer return matches — callers that pass these ids must be removed in §5.2.

### 5.2 · `packages/hub/src/router.ts`

- In the `case "task_completed":` handler, remove the `dispatchTopic(this.db, this.push, getTopic("completed"), …)` call.
- In the offline-timer block (`onDaemonDisconnect` at L306-335) — the **whole** `setTimeout` body exists solely to dispatch the offline push, so the entire timer scheduling, `offlineTimers` Map, `offlineMeta` Map, and the matching cancel logic in `case "hello"` (`L70-72`) can all be removed together. Cleaner, leaves no dead state.
- The `idle` and `permission` dispatch paths are unchanged.

### 5.3 · `packages/hub/src/schema.ts`

- Drop `push_subs_completed` view (L94) and `push_subs_offline` view (L90). Bare `push_subs` table preserves `preferences` JSON, so old per-user `completed:true` keys are still readable but never queried.
- No migration script needed: views are derived, not data.

### 5.4 · DB forward-compat

`push_subs.preferences` JSON keys keyed on `completed` / `offline` become inert. If we ever want to re-introduce one of these topics, the keys are still there; we just re-add the topic + view. Recording this as **deliberate** on the schema comment.

## 6 · Test plan

| Layer | Existing | New / changed |
|---|---|---|
| **Unit (PWA)** | usePermissionQueue tests deleted | `InlinePermissionCard.test.tsx` — render with various request shapes; allow/deny invokes `onDecide`; pending state disables buttons |
| **Unit (proto/hub)** | `frames.test.ts` unchanged (no proto change) | `push-topics.test.ts` — assert `TOPICS.map(t => t.id) === ["permission", "idle"]` |
| **e2e-real** | `02-permission-relay.test.ts` and `03-permission-deny.test.ts` look for `PermissionSurface` modal — **rewrite** to look for `data-testid="inline-permission-card"` inside SessionView; flow: select session → click Allow → assert card unmounts + permission frame round-trips to daemon | `04-history-scrollback.test.ts` etc. unchanged |
| **Manual** | Playwright probe walking: home with pending session → click into session → InlinePermissionCard renders → click Allow → card disappears + session card transitions back to working/idle. Captured screenshots committed to PR description. | — |

## 7 · Migration notes

- **In-flight permissions when the change ships**: any user with the PWA tab open at deploy time keeps their reducer state. The `PermissionSurface` import would error post-deploy if HMR'd in mid-modal — minor; full reload fixes it.
- **Stored push prefs with `completed:true`**: silently inert. We will not run a backfill to clean keys.
- **Hooks (CC `.claude/hooks/ask-user-relay.ts`)**: untouched. AskUserQuestion path is independent.

## 8 · Rollout

Single PR. The PWA delete + add + hub topic prune are tightly coupled — splitting them invites half-shipped intermediate states (Bell with no badge, modal that's never opened). Tests in the same PR.

## 9 · Out-of-scope follow-ups

- **Multi-session permission stacking UX**: if the inline card pattern surfaces a real "I have 3 sessions waiting" pain we'll revisit. Won't pre-build.
- **AskUserQuestion + permission consolidation**: both are now session-level surfaces but render as separate components. A future refactor could share a `<DecisionPrompt>` primitive — not now.
- **Push notification deep-linking** to a specific session: today push tap-through opens the PWA but doesn't auto-select the session. Worth doing but separate change.
