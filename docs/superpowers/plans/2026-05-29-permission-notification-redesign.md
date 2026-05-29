# Permission UX & Notification Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move PWA permission UI from app-level (Bell icon + global modal + cross-session queue) to session-level (an inline card inside the selected session's timeline). Trim push topic registry from 4 (`permission`/`offline`/`completed`/`idle`) to 2 (`permission`/`idle`).

**Architecture:** No proto / daemon / hub-router behavioral change for permission flow — `permission_request` frame still lands in PWA `pendingPermissions` reducer slice. Consumer-side rewrite only:
1. Add `InlinePermissionCard` primitive that renders a request inline (variant B — prominent card with code block + Allow/Deny buttons).
2. `SessionView` mounts the card at the top of the timeline scroll area when this session has a pending request.
3. `HomeScreen.SessionRow` already shows `permission needed (Bash)` text — promote the activity line above cwd in waiting state, bump left border to 2px.
4. Delete `usePermissionQueue` hook, `PermissionSurface` modal, `PermissionMiniCard` home-banner component, Bell icon (mobile header + DesktopNav rail), `topPendingPreview` prop chain through AppShell, and `pendingApprovalsCount` calculation.
5. Hub: drop `completedTopic` and `offlineTopic` from `PUSH_TOPICS` registry; remove `dispatchTopic(getTopic("completed"), …)` from `task_completed` handler; remove the entire offline-timer block (`offlineTimers` Map, `offlineMeta` Map, the `setTimeout` body, and the matching cancel logic in `case "hello"`).
6. PWA SettingsDrawer needs no code change — its topic list is server-driven via `/push/topics` HTTP endpoint that returns `PUSH_TOPICS`.

**Tech Stack:** React 18 + TypeScript + Tailwind v4 (CSS variables in `packages/pwa/src/styles.css`). Hub: TypeScript on Bun. Tests: `bun test` (unit) + `@playwright/test` (e2e-real).

---

## File Structure

### Files created

| Path | Responsibility |
|---|---|
| `packages/pwa/src/screens/primitives/InlinePermissionCard.tsx` | Pure presentational React component — renders a `PwaPermissionRequest` as an inline session-timeline card with Allow/Deny buttons; no hub access, all behavior via props. |
| `packages/pwa/tests/InlinePermissionCard.test.tsx` | Unit tests for the new card (render shape, callback wiring, pending state). |

### Files deleted

| Path | Why |
|---|---|
| `packages/pwa/src/hooks/usePermissionQueue.ts` | Cross-session queue + handled-notice state machine no longer has a UI to drive. |
| `packages/pwa/tests/usePermissionQueue.test.tsx` | Tests the deleted hook. |
| `packages/pwa/src/screens/PermissionSurface.tsx` | Full-screen modal goes away. |
| `packages/pwa/tests/PermissionSurface.test.tsx` | Tests the deleted modal. |
| `e2e-real/tests/15-multi-pending.test.ts` | The cross-session queue + "1 of 2 pending" + "Already handled on another device" toast it tests no longer exist (per spec §2 non-goal: no batched/cross-session approve power-user shortcut). |

### Files modified

| Path | Change |
|---|---|
| `packages/pwa/src/RealApp.tsx` | Drop `usePermissionQueue` import + call, drop `pendingApprovalsCount` + `topPending`/`topPendingPreview` calc, drop `<PermissionSurface>` mount block, drop `permissionQueue.handledNotice` toast block, drop unused `totalPendingApprovals` import. Update SessionView render to pass `pendingPermission` (the request) + `pendingPermissionReply` + `onSendPermissionReply` instead of `onOpenPermission`. |
| `packages/pwa/src/screens/AppShell.tsx` | Remove `pendingApprovalsCount` and `onOpenPermission` props; remove mobile-header Bell button + DesktopNav Bell button. `Bell` import drops too. |
| `packages/pwa/src/screens/HomeScreen.tsx` | Remove `pendingApprovalsCount`, `topPendingPreview`, `onOpenPermission` props; remove `PermissionMiniCard` component + `TopPendingPreview` interface. In `SessionRow`, bump left border to `border-l-2` for waiting state and reorder lines so activity comes before cwd when state is "waiting". |
| `packages/pwa/src/screens/SessionView.tsx` | Replace the inline warning banner block (L136-147) with `<InlinePermissionCard>` rendered in the timeline area. Drop `onOpenPermission` prop, add `pendingPermissionReply?: PendingCommand` and `onSendPermissionReply: (decision) => void` props. |
| `packages/pwa/tests/SessionView.test.tsx` | Drop all `onOpenPermission={() => {}}` props from test calls; rewrite the "permission warning strip" test to assert the inline card data-testid. |
| `packages/pwa/tests/HomeScreen.test.tsx` | Drop `pendingApprovalsCount`, `topPendingPreview`, `onOpenPermission` from test props. Drop the "renders mini card" test. Drop "omits mini card" test. Add a test that asserts the SessionRow waiting-state shows activity above cwd and has `border-l-2`. |
| `packages/pwa/src/lib/daemonViewModel.ts` | Delete `totalPendingApprovals` export (no longer used). |
| `packages/pwa/src/demo/DemoApp.tsx` | Demo-only file. Out of scope for behavior, but keep build-clean — leave its internal `PermissionMiniCard` + `PermissionSurface` self-contained mocks alone (they don't import the real ones). Verify no broken imports after deleting real `PermissionSurface.tsx`. |
| `packages/hub/src/push-topics.ts` | Remove `completedTopic` and `offlineTopic` consts. `PUSH_TOPICS` becomes `[permissionTopic, idleTopic]`. The `OfflineCtx` type becomes unused — delete it. |
| `packages/hub/src/router.ts` | Drop `offlineTimers` field, `offlineMeta` field, `offlinePushDelayMs` field, `RouterOptions.offline_push_delay_ms`, `DEFAULT_OFFLINE_PUSH_DELAY_MS` const. Drop the cancel block in `case "hello"`. Drop `dispatchTopic(getTopic("completed"), …)` from `case "task_completed"`. Drop the `setTimeout` block in `onDaemonDisconnect` — keep only `daemons.delete` + `daemon_offline` broadcast. |
| `packages/hub/tests/push-topics-registry.test.ts` | Update assertions: `PUSH_TOPICS.map(t => t.id).sort()` becomes `["idle", "permission"]`; the loop checking `default_enabled === false` for "offline"/"completed"/"idle" becomes just `["idle"]`. |
| `packages/hub/tests/push-topics-payloads.test.ts` | Remove "offline payload" test (L20-28) and "completed payload" test (L30-37). Remove "missing optional context fields default safely" test (L47-50) — depends on offline. |
| `e2e-real/tests/02-permission-relay.test.ts` | Rewrite: target inline card by `data-testid="inline-permission-card"`, click Allow inside the SessionView — no Review modal hop. Drop `permission-mini` Promise.race fallback. |
| `e2e-real/tests/03-permission-deny.test.ts` | Same shape: select session → inline card → Deny → assert card unmounts. Drop `permission-mini` and `permission-surface` references. |
| `e2e-real/tests/21-push-topics.test.ts` | Topic list assertion becomes `["idle", "permission"]`. Replace the "offline" subscription path (L53-64) with an idle-topic dispatch verification, OR delete that whole step (the registry test already asserts the topic list and `dispatchTopic` is covered by `push-dispatch.test.ts`). Since the test name explicitly tests the offline-push end-to-end pipeline that we're deleting, **delete the whole test file**. |
| `e2e-real/tests/11-offline-push.test.ts` | Despite its name, this scenario tests `/push/subscribe` *registration*, NOT the offline topic dispatch (per file-level comment block). It survives the redesign unchanged — verify by reading. |

---

## Task ordering rationale

Tasks 1-4 establish the new presentational primitive in isolation (TDD, no production wiring yet) — safe to land independently. Tasks 5-8 wire it into SessionView, RealApp, and trim AppShell/HomeScreen — the PWA half ships as one coherent set. Tasks 9-12 prune the hub. Tasks 13-15 update e2e tests + manual verification. Each task is one commit.

---

### Task 1: Add `InlinePermissionCard` primitive — failing test first

**Files:**
- Create: `packages/pwa/tests/InlinePermissionCard.test.tsx`
- Test: `bun test packages/pwa/tests/InlinePermissionCard.test.tsx`

- [ ] **Step 1: Write the failing test file**

Create `packages/pwa/tests/InlinePermissionCard.test.tsx`:

```tsx
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PwaPermissionRequest } from "@cc-remote/proto";
import type { PendingCommand } from "../src/hooks/pendingCommands";
import { InlinePermissionCard } from "../src/screens/primitives/InlinePermissionCard";

const baseRequest: PwaPermissionRequest = {
  type: "permission_request",
  daemon_id: "d1",
  session_id: "s1",
  request_id: "req-abc12345",
  tool: "Bash",
  args_summary: "rm -rf /tmp/cc-remote-demo/scratch.txt",
  expires_at: 0,
};

test("InlinePermissionCard renders tool, command, and request_id slice", () => {
  const markup = renderToStaticMarkup(
    <InlinePermissionCard request={baseRequest} onDecide={() => {}} />,
  );
  expect(markup).toContain('data-testid="inline-permission-card"');
  expect(markup).toContain("Permission");
  expect(markup).toContain("Bash");
  expect(markup).toContain("rm -rf /tmp/cc-remote-demo/scratch.txt");
  // request_id slice 0..8 — first 8 chars displayed
  expect(markup).toContain("req-abc1");
});

test("InlinePermissionCard exposes Allow and Deny buttons", () => {
  const markup = renderToStaticMarkup(
    <InlinePermissionCard request={baseRequest} onDecide={() => {}} />,
  );
  expect(markup).toMatch(/<button[^>]*>\s*Allow once\s*<\/button>/);
  expect(markup).toMatch(/<button[^>]*>\s*Deny\s*<\/button>/);
});

test("InlinePermissionCard disables both buttons while reply is pending", () => {
  const pending: PendingCommand = {
    id: "req-abc12345",
    kind: "permission_reply",
    daemon_id: "d1",
    session_id: "s1",
    started_at: 0,
    status: "pending",
    label: "allow",
  };
  const markup = renderToStaticMarkup(
    <InlinePermissionCard request={baseRequest} pendingReply={pending} onDecide={() => {}} />,
  );
  expect(markup).toMatch(/<button[^>]*disabled[^>]*>\s*Allow once/);
  expect(markup).toMatch(/<button[^>]*disabled[^>]*>\s*Deny/);
  expect(markup).toContain("Sending decision");
});

test("InlinePermissionCard shows timeout copy when reply timed_out", () => {
  const timedOut: PendingCommand = {
    id: "req-abc12345",
    kind: "permission_reply",
    daemon_id: "d1",
    session_id: "s1",
    started_at: 0,
    status: "timed_out",
    label: "allow",
  };
  const markup = renderToStaticMarkup(
    <InlinePermissionCard request={baseRequest} pendingReply={timedOut} onDecide={() => {}} />,
  );
  expect(markup).toContain("Decision not confirmed");
});

test("InlinePermissionCard renders verbatim args even when very long", () => {
  const longArgs = "find . -type f -name '*.log' | xargs -I{} echo {} | sort | uniq -c | head -100";
  const markup = renderToStaticMarkup(
    <InlinePermissionCard
      request={{ ...baseRequest, args_summary: longArgs }}
      onDecide={() => {}}
    />,
  );
  expect(markup).toContain(longArgs);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/pwa/tests/InlinePermissionCard.test.tsx`
Expected: FAIL — `Cannot find module '../src/screens/primitives/InlinePermissionCard'`

- [ ] **Step 3: Implement the component**

Create `packages/pwa/src/screens/primitives/InlinePermissionCard.tsx`:

```tsx
import { ShieldAlert } from "lucide-react";
import type { PwaPermissionRequest } from "@cc-remote/proto";
import { Button } from "../../components/ui/button";
import type { PendingCommand } from "../../hooks/pendingCommands";

export interface InlinePermissionCardProps {
  request: PwaPermissionRequest;
  /** When set, the card is in an "awaiting daemon ack" state — buttons disabled, status text shown. */
  pendingReply?: PendingCommand;
  onDecide(decision: "allow" | "deny"): void;
}

/**
 * Inline session-bound permission prompt. Replaces the deleted full-screen
 * `<PermissionSurface>` modal. Lives in `SessionView`'s timeline scroll area
 * — only renders when the SELECTED session has a pending permission request.
 *
 * Visual contract (variant B per the design spec):
 *   - Container with warning-tinted border + subtle shadow
 *   - Header: small uppercase pill + tool name + truncated request_id
 *   - Black-on-light code block with the verbatim args_summary
 *   - Right-aligned action row: Deny (secondary) + Allow once (default)
 *
 * The component is purely presentational: hub access, sendPermissionReply,
 * and pendingPermissions reducer state all live above. When the request is
 * resolved (locally or cross-device), `pendingPermissions[request_id]`
 * disappears from the reducer and the parent unmounts this card naturally —
 * no internal "handled by another device" logic.
 */
export function InlinePermissionCard({
  request,
  pendingReply,
  onDecide,
}: InlinePermissionCardProps) {
  const submitting = pendingReply?.status === "pending";
  const replyTimedOut = pendingReply?.status === "timed_out";
  const reqIdShort = request.request_id.slice(0, 8);

  return (
    <article
      className="rounded-card border-warning/35 bg-surface flex flex-col gap-3 border p-4 shadow-[0_8px_24px_rgba(217,119,6,0.06)]"
      data-testid="inline-permission-card"
      data-request-id={request.request_id}
    >
      <div className="flex items-center gap-2">
        <span className="bg-warning-subtle text-warning inline-flex h-[22px] items-center rounded-full px-2 text-[11px] font-bold tracking-wider uppercase">
          Permission
        </span>
        <ShieldAlert className="text-warning size-4" />
        <span className="text-foreground font-semibold">{request.tool}</span>
        <span className="flex-1" />
        <span className="text-muted-foreground font-mono text-xs">
          request {reqIdShort}
        </span>
      </div>

      <code className="bg-code text-code-foreground block rounded-sm p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">
        $ {request.args_summary}
      </code>

      {submitting && (
        <p
          className="text-muted-foreground text-sm"
          data-testid="inline-permission-submitting"
        >
          Sending decision…
        </p>
      )}
      {replyTimedOut && (
        <p
          className="text-danger text-sm"
          role="alert"
          data-testid="inline-permission-timeout"
        >
          Decision not confirmed. Try again.
        </p>
      )}

      <div className="flex items-center justify-end gap-2">
        <Button
          onClick={() => onDecide("deny")}
          size="md"
          variant="secondary"
          disabled={submitting}
        >
          Deny
        </Button>
        <Button
          onClick={() => onDecide("allow")}
          size="md"
          disabled={submitting}
        >
          Allow once
        </Button>
      </div>
    </article>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/pwa/tests/InlinePermissionCard.test.tsx`
Expected: PASS — 5 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add packages/pwa/src/screens/primitives/InlinePermissionCard.tsx packages/pwa/tests/InlinePermissionCard.test.tsx
git commit -m "pwa: add InlinePermissionCard primitive

Session-level replacement for the global PermissionSurface modal.
Variant B per design spec — prominent card with tool name, full
command in code block, Allow once / Deny buttons, pending + timeout
states.

Pure presentational. Mounted by SessionView only when the SELECTED
session has a pending permission_request. When the reducer drops
the request (local resolve or cross-device), the parent unmounts
naturally.

Tests cover: rendering, button presence, pending disables both,
timed_out copy, verbatim long-args."
```

---

### Task 2: Wire `InlinePermissionCard` into `SessionView`

**Files:**
- Modify: `packages/pwa/src/screens/SessionView.tsx`
- Modify: `packages/pwa/tests/SessionView.test.tsx`

- [ ] **Step 1: Update the SessionView test for the new props + inline card render**

Edit `packages/pwa/tests/SessionView.test.tsx`. Replace the test at L65-91 ("shows the permission warning strip when blocked") with this version that asserts the inline card:

```tsx
test("SessionView renders InlinePermissionCard inside the timeline when this session has a pending request", () => {
  const markup = renderToStaticMarkup(
    <SessionView
      header={{ name: "session-1", model: null, cwd: "/x", online: true }}
      items={[]}
      composerBlocked={true}
      pendingPermissionInThisSession={{
        type: "permission_request",
        daemon_id: "d",
        session_id: "s",
        request_id: "req-1",
        tool: "Bash",
        args_summary: "rm -rf /",
        expires_at: 1_700_000_000,
      }}
      onSendPermissionReply={() => {}}
      onLoadEarlier={() => {}}
      onSendChat={() => {}}
      onBack={() => {}}
    />,
  );

  expect(markup).toContain('data-testid="inline-permission-card"');
  expect(markup).toContain("rm -rf /");
  expect(markup).toContain("Bash");
  // composer placeholder still says "Waiting for permission" while blocked
  expect(markup).toContain("Waiting for permission");
});

test("SessionView reflects pendingPermissionReply spinner state on the inline card", () => {
  const markup = renderToStaticMarkup(
    <SessionView
      header={{ name: "session-1", model: null, cwd: "/x", online: true }}
      items={[]}
      composerBlocked={true}
      pendingPermissionInThisSession={{
        type: "permission_request",
        daemon_id: "d",
        session_id: "s",
        request_id: "req-1",
        tool: "Bash",
        args_summary: "ls",
        expires_at: 0,
      }}
      pendingPermissionReply={{
        id: "req-1",
        kind: "permission_reply",
        daemon_id: "d",
        session_id: "s",
        started_at: 0,
        status: "pending",
        label: "allow",
      }}
      onSendPermissionReply={() => {}}
      onLoadEarlier={() => {}}
      onSendChat={() => {}}
      onBack={() => {}}
    />,
  );

  expect(markup).toContain("Sending decision");
  expect(markup).toMatch(/<button[^>]*disabled[^>]*>\s*Allow once/);
});
```

Also drop ALL `onOpenPermission={() => {}}` lines from this file (use sed or manual — every occurrence). The other tests stop passing that prop because we're removing it.

- [ ] **Step 2: Run test to confirm it fails**

Run: `bun test packages/pwa/tests/SessionView.test.tsx`
Expected: FAIL on `pendingPermissionInThisSession` test — markup doesn't contain `data-testid="inline-permission-card"` (still rendering the old warning strip).

- [ ] **Step 3: Modify `SessionView.tsx`**

Edit `packages/pwa/src/screens/SessionView.tsx`:

Replace the imports block at L1-9 with:

```tsx
import { useState } from "react";
import { ArrowLeft, Send, X } from "lucide-react";
import type { PwaPermissionRequest, SlashEntry } from "@cc-remote/proto";
import { Button } from "../components/ui/button";
import { StatusChip } from "./primitives/StatusChip";
import { SessionTimeline } from "./timeline/SessionTimeline";
import type { RenderItem } from "./timeline/types";
import type { PendingCommand } from "../hooks/pendingCommands";
import { SlashMenu } from "./primitives/SlashMenu";
import { InlinePermissionCard } from "./primitives/InlinePermissionCard";
```

(removes `filterEntries` from the SlashMenu import — it was unused — and adds `InlinePermissionCard`.)

Replace the `SessionViewProps` interface (L11-33):

```tsx
export interface SessionViewProps {
  header: { name: string; model: string | null; cwd: string; online: boolean };
  items: RenderItem[];
  composerBlocked: boolean;
  pendingPermissionInThisSession?: PwaPermissionRequest;
  /** PendingCommand keyed on the request_id, set while the daemon ack is in flight. */
  pendingPermissionReply?: PendingCommand;
  chatError?: string;
  connected?: boolean;
  idle?: boolean;
  hasMoreEarlier?: boolean;
  historyLoading?: boolean;
  historyTimedOut?: boolean;
  maxOffset?: number;
  unreadCount?: number;
  pendingChatSend?: PendingCommand;
  slashEntries?: SlashEntry[];
  onMarkSeen?: (offset: number) => void;
  onLoadEarlier: () => void;
  onSendChat: (content: string) => void;
  onSendCliCommand?: (text: string) => void;
  /** Decision handler for the inline permission card. Wired by RealApp. */
  onSendPermissionReply?: (decision: "allow" | "deny") => void;
  onBack: () => void;
  onDismissPendingCommand?: (id: string) => void;
}
```

Replace the destructuring (L35-57):

```tsx
export function SessionView({
  header,
  items,
  composerBlocked,
  pendingPermissionInThisSession,
  pendingPermissionReply,
  chatError,
  connected = true,
  idle = false,
  hasMoreEarlier = true,
  historyLoading,
  historyTimedOut,
  maxOffset,
  unreadCount,
  pendingChatSend,
  slashEntries = [],
  onMarkSeen,
  onLoadEarlier,
  onSendChat,
  onSendCliCommand,
  onSendPermissionReply,
  onBack,
  onDismissPendingCommand,
}: SessionViewProps) {
```

In the timeline body section (around L112-125), insert the inline card right above `<SessionTimeline>` so it scrolls with the conversation:

```tsx
      <div className="flex flex-1 flex-col overflow-hidden" data-testid="chat-log">
        {pendingPermissionInThisSession && onSendPermissionReply && (
          <div className="px-3 pt-3">
            <InlinePermissionCard
              request={pendingPermissionInThisSession}
              pendingReply={pendingPermissionReply}
              onDecide={onSendPermissionReply}
            />
          </div>
        )}
        <SessionTimeline
          items={items}
          idle={idle}
          hasMoreEarlier={hasMoreEarlier}
          historyLoading={historyLoading}
          historyTimedOut={historyTimedOut}
          onLoadEarlier={onLoadEarlier}
          maxOffset={maxOffset}
          unreadCount={unreadCount}
          onMarkSeen={onMarkSeen}
        />
      </div>
```

(Also drop `onOpenPermission={onOpenPermission}` from the `<SessionTimeline>` props — `SessionTimeline` doesn't actually use it for rendering — verify by `grep -n onOpenPermission packages/pwa/src/screens/timeline/SessionTimeline.tsx`; if it has no use, the type signature there can be tightened in a later cleanup. If `SessionTimeline` does still take it, keep passing `undefined` for now and queue cleanup as a follow-up — do NOT block this task.)

Delete the existing inline warning strip block (originally L136-147):

```tsx
        {composerBlocked && pendingPermissionInThisSession && (
          <div className="bg-warning-subtle text-warning mb-2 flex items-center justify-between gap-2 rounded-md px-3 py-2 text-sm">
            <span>Permission required before Claude can continue.</span>
            <Button
              onClick={() => onOpenPermission(pendingPermissionInThisSession.request_id)}
              size="sm"
              variant="secondary"
            >
              Review
            </Button>
          </div>
        )}
```

— remove the entire block. The inline card above the timeline is the new affordance; the composer placeholder ("Waiting for permission") already conveys the blocked state.

- [ ] **Step 4: Run test to confirm pass**

Run: `bun test packages/pwa/tests/SessionView.test.tsx`
Expected: PASS — all tests including the two new ones.

- [ ] **Step 5: Run all PWA unit tests to catch collateral**

Run: `bun test packages/pwa`
Expected: PASS for InlinePermissionCard.test, SessionView.test. RealApp / HomeScreen tests may still fail on `onOpenPermission` removal — that's expected and addressed in tasks 3-4.

- [ ] **Step 6: Commit**

```bash
git add packages/pwa/src/screens/SessionView.tsx packages/pwa/tests/SessionView.test.tsx
git commit -m "pwa: SessionView mounts InlinePermissionCard at top of timeline

Replaces the inline 'Permission required before Claude can continue'
warning strip with the new InlinePermissionCard component. The card
lives in the timeline scroll area so it sits with the conversation
events that prompted it (mental model: permission is a turn event).

Drops onOpenPermission prop, adds pendingPermissionReply +
onSendPermissionReply props. The composer's blocked-state placeholder
('Waiting for permission') still conveys why typing is disabled."
```

---

### Task 3: Strip Bell + permission props from `AppShell`

**Files:**
- Modify: `packages/pwa/src/screens/AppShell.tsx`
- Test: existing `packages/pwa/tests/App.test.tsx` (RealApp smoke test) — verify it still passes after Task 5 wires RealApp.

- [ ] **Step 1: Edit `AppShell.tsx`**

Replace the import line at L1:
```tsx
import { Laptop, Settings } from "lucide-react";
```
(removing `Bell` — no longer used here.)

Replace the `AppShellProps` interface (L24-36):
```tsx
export interface AppShellProps {
  device: AppShellDevice;
  connected: boolean;
  onOpenSettings: () => void;
  onSignOut: () => void;
  /** Side-by-side panes when device !== mobile. On mobile, one or the other. */
  home: React.ReactNode;
  session?: React.ReactNode;
  /** True on mobile when a session is selected so HomeScreen is hidden. */
  sessionActiveOnMobile?: boolean;
}
```

Replace the function signature destructuring (L38-48):
```tsx
export function AppShell({
  device,
  connected,
  onOpenSettings,
  onSignOut,
  home,
  session,
  sessionActiveOnMobile = false,
}: AppShellProps) {
```

Delete the mobile-header Bell button (L98-112):
```tsx
          {device !== "desktop" && (
            <button
              aria-label={`Permissions (${pendingApprovalsCount} pending)`}
              ...
              <Bell className="size-4" />
              ...
            </button>
          )}
```
— remove the entire block. Result: on mobile/tablet only `<StatusChip>` + `<Sign out>`-or-nothing + Settings remain in the header.

In the desktop body grid block (around L132-138), update the `DesktopNav` invocation:
```tsx
        {device === "desktop" && (
          <DesktopNav onOpenSettings={onOpenSettings} />
        )}
```

Replace the `DesktopNav` function (L180-218):
```tsx
function DesktopNav({
  onOpenSettings,
}: {
  onOpenSettings: () => void;
}) {
  return (
    <nav className="border-border bg-surface flex flex-col items-center gap-3 border-r px-3 py-4">
      <button
        aria-label="Machines"
        className="text-foreground bg-muted flex size-11 items-center justify-center rounded-md"
      >
        <Laptop className="size-5" />
      </button>
      <button
        aria-label="Settings"
        className="text-muted-foreground hover:bg-muted hover:text-foreground flex size-11 items-center justify-center rounded-md"
        onClick={onOpenSettings}
      >
        <Settings className="size-5" />
      </button>
    </nav>
  );
}
```

(Removed: middle Bell button + its `pendingApprovalsCount` + `onOpenPermission` deps.)

- [ ] **Step 2: Confirm build still type-checks for AppShell**

Run: `bun --bun tsc --noEmit -p packages/pwa/tsconfig.json 2>&1 | grep -i "AppShell\|appshell"`
Expected: errors mentioning `RealApp.tsx` referencing missing props (`pendingApprovalsCount`, `onOpenPermission`) — those are addressed in Task 5. No errors strictly within `AppShell.tsx` itself.

- [ ] **Step 3: Commit**

```bash
git add packages/pwa/src/screens/AppShell.tsx
git commit -m "pwa: AppShell drops Bell icon + permission count props

Bell-as-notification-center is being removed: session card is the
single 'this session needs attention' surface (border-warning + an
activity line). pendingApprovalsCount and onOpenPermission props
disappear from AppShell; mobile-header Bell button and DesktopNav
Bell button delete with them.

RealApp + HomeScreen will follow in tasks 4-5 — the build is
intentionally broken between commits during this task."
```

---

### Task 4: Strip permission-mini-card and props from `HomeScreen`

**Files:**
- Modify: `packages/pwa/src/screens/HomeScreen.tsx`
- Modify: `packages/pwa/tests/HomeScreen.test.tsx`

- [ ] **Step 1: Edit `HomeScreen.tsx`**

Replace the imports at L1-2:
```tsx
import { useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
```
(removing `ShieldAlert` — only used in `PermissionMiniCard` which we're deleting.)

Delete the `TopPendingPreview` interface (L15-20).

Replace the `HomeScreenProps` interface (L22-36):
```tsx
export interface HomeScreenProps {
  daemons: DaemonViewModel[];
  selectedSessionId?: string;
  onSelectSession: (daemon_id: string, session_id: string) => void;
  onStartSession: (daemon_id: string, cwd: string) => void;
  onKillSession: (daemon_id: string, session_id: string) => void;
  /** Per-daemon last start_session_rejected, surfaced inline. */
  startSessionErrors?: Record<string, PwaStartSessionRejected>;
  onDismissStartSessionError?: (daemon_id: string) => void;
  pendingStartSessionByDaemon?: Record<string, PendingCommand>;
  pendingKillByKey?: Record<string, PendingCommand>;  // key: `${daemon_id}::${session_id}`
}
```

Replace the function signature destructuring (L38-51):
```tsx
export function HomeScreen({
  daemons,
  selectedSessionId,
  onSelectSession,
  onStartSession,
  onKillSession,
  startSessionErrors,
  onDismissStartSessionError,
  pendingStartSessionByDaemon,
  pendingKillByKey,
}: HomeScreenProps) {
```

Delete the mini-card block (L69-75):
```tsx
        {pendingApprovalsCount > 0 && topPendingPreview && (
          <PermissionMiniCard
            count={pendingApprovalsCount}
            preview={topPendingPreview}
            onReview={onOpenPermission}
          />
        )}
```

Delete the entire `PermissionMiniCard` function (L109-142). It was only called above.

In `SessionRow` (L318-413), update the styling for waiting state. Replace the `<div className={cn(...)}>` opening (L339-344):

```tsx
    <div
      className={cn(
        "bg-surface shadow-card min-w-0 rounded-md border p-3",
        session.state === "waiting"
          ? "border-warning/45 border-l-2 border-l-warning"
          : "border-border",
        selected && "ring-primary/40 ring-2",
      )}
    >
```

Reorder the inner span block so activity comes above cwd in waiting state. Replace the inner content of the button (L347-362):

```tsx
      <button
        className="flex min-h-[44px] w-full min-w-0 items-start gap-3 text-left"
        onClick={onSelect}
      >
        <StatusIcon state={session.state} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center justify-between gap-2">
            <span className="truncate font-semibold">{session.name}</span>
            <StatusChip label={stateLabel(session.state)} tone={session.state} />
          </span>
          {session.state === "waiting" ? (
            <>
              <span className="text-warning mt-1 block truncate text-xs font-semibold">
                {session.activity}
              </span>
              <span className="text-muted-foreground mt-1 block truncate font-mono text-xs">
                {session.model} · {session.cwd}
              </span>
            </>
          ) : (
            <>
              <span className="text-muted-foreground mt-1 block truncate font-mono text-xs">
                {session.model} · {session.cwd}
              </span>
              <span className="text-muted-foreground mt-1 block text-xs">
                unread {session.unread} · tasks {session.tasks} · {session.activity}
              </span>
            </>
          )}
        </span>
      </button>
```

- [ ] **Step 2: Update `HomeScreen.test.tsx`**

Edit `packages/pwa/tests/HomeScreen.test.tsx`:

Drop the test "HomeScreen renders mini card, online daemon, and offline daemon" (L44-69) entirely (mini card is gone). Replace with:

```tsx
test("HomeScreen renders online + offline daemons with their session lists", () => {
  const markup = renderToStaticMarkup(
    <HomeScreen
      daemons={[onlineDaemon, offlineDaemon]}
      onSelectSession={() => {}}
      onStartSession={() => {}}
      onKillSession={() => {}}
    />,
  );
  expect(markup).toContain("mbp.local");
  expect(markup).toContain("vm-eu");
  expect(markup).toContain("Waiting");
  expect(markup).toContain("Offline");
  expect(markup).toContain('data-testid="machine-card-d1"');
  expect(markup).toContain('data-testid="sessions-d1"');
});

test("HomeScreen no longer renders permission-mini regardless of pending count", () => {
  const markup = renderToStaticMarkup(
    <HomeScreen
      daemons={[onlineDaemon]}
      onSelectSession={() => {}}
      onStartSession={() => {}}
      onKillSession={() => {}}
    />,
  );
  expect(markup).not.toContain("permission-mini");
  expect(markup).not.toContain("approval waiting");
});

test("HomeScreen waiting-state SessionRow promotes activity above cwd and uses border-l-2", () => {
  const markup = renderToStaticMarkup(
    <HomeScreen
      daemons={[onlineDaemon]}
      onSelectSession={() => {}}
      onStartSession={() => {}}
      onKillSession={() => {}}
    />,
  );
  // border-l-2 on the row container in waiting state
  expect(markup).toMatch(/border-l-2/);
  // activity text appears in the markup before the model · cwd line for the waiting session
  const idxActivity = markup.indexOf("permission needed (Bash)");
  const idxCwd = markup.indexOf("/work/repo");
  expect(idxActivity).toBeGreaterThan(0);
  expect(idxCwd).toBeGreaterThan(idxActivity);
});
```

Drop the test "HomeScreen omits mini card when no approvals are pending" (L71-83) — already covered by the test above.

Remove `pendingApprovalsCount={...}` and `topPendingPreview={...}` and `onOpenPermission={() => {}}` from EVERY remaining test in this file.

- [ ] **Step 3: Run tests**

Run: `bun test packages/pwa/tests/HomeScreen.test.tsx`
Expected: PASS — all tests.

- [ ] **Step 4: Commit**

```bash
git add packages/pwa/src/screens/HomeScreen.tsx packages/pwa/tests/HomeScreen.test.tsx
git commit -m "pwa: HomeScreen drops PermissionMiniCard, polishes waiting SessionRow

Mini-card global banner is gone — session card is the single
attention surface. Waiting-state row gets border-l-2 + warning
left edge so it pops out of a uniform list.

Activity line ('permission needed (Bash)') promoted above cwd in
waiting state — visual hierarchy: state chip + permission summary
beat cwd in priority when waiting."
```

---

### Task 5: Wire SessionView callbacks in `RealApp`, drop modal + queue + helpers

**Files:**
- Modify: `packages/pwa/src/RealApp.tsx`
- Modify: `packages/pwa/src/lib/daemonViewModel.ts`

- [ ] **Step 1: Edit `RealApp.tsx`**

Remove these imports (L13, L17, L18):
```tsx
import { computeDaemonViewModels, totalPendingApprovals } from "./lib/daemonViewModel";
import { usePermissionQueue } from "./hooks/usePermissionQueue";
import { PermissionSurface } from "./screens/PermissionSurface";
```
Replace with:
```tsx
import { computeDaemonViewModels } from "./lib/daemonViewModel";
```

Delete L83-96 (queue setup + active-request effect):
```tsx
  const permissionQueue = usePermissionQueue(pendingPermissions);
  const pendingApprovalsCount = totalPendingApprovals(pendingPermissions);

  const pendingReply = permissionQueue.active
    ? pendingPermissionReplyFor(permissionQueue.active.request_id)
    : undefined;

  const activeRequestId = permissionQueue.active?.request_id;
  useEffect(() => {
    if (!activeRequestId) return;
    if (!pendingPermissions[activeRequestId]) {
      permissionQueue.advance();
    }
  }, [activeRequestId, pendingPermissions, permissionQueue]);
```

Delete L143-153 (top pending calc):
```tsx
  const topPending = Object.values(pendingPermissions)[0];
  const topPendingPreview = topPending
    ? {
        daemonHostname:
          daemons.find((d) => d.daemon_id === topPending.daemon_id)?.hostname ??
          topPending.daemon_id,
        sessionName: topPending.session_id,
        tool: topPending.tool,
        commandSummary: topPending.args_summary,
      }
    : undefined;
```

Compute the active session's pendingPermission and the matching pending reply right before the `return`:

```tsx
  const pendingPermissionInSelectedSession = selected
    ? Object.values(pendingPermissions).find(
        (p) =>
          p.daemon_id === selected.daemon_id &&
          p.session_id === selected.session_id,
      )
    : undefined;

  const pendingPermissionReply = pendingPermissionInSelectedSession
    ? pendingPermissionReplyFor(pendingPermissionInSelectedSession.request_id)
    : undefined;
```

(Place these alongside the existing `selectedChatError` / `pendingChatSend` / `selectedDaemon` / `selectedSession` block at L159-164.)

In the JSX, update the `<AppShell>` prop list (L168-175) — remove `pendingApprovalsCount` and `onOpenPermission`:

```tsx
      <AppShell
        device={device}
        connected={connected}
        onOpenSettings={() => setShowSettings(true)}
        onSignOut={() => signOut()}
        sessionActiveOnMobile={!!selected}
```

In the `<HomeScreen>` invocation (L177-190), drop `pendingApprovalsCount`, `topPendingPreview`, `onOpenPermission`:

```tsx
          <HomeScreen
            daemons={daemonModels}
            selectedSessionId={selected?.session_id}
            onSelectSession={(daemon_id, session_id) => setSelected({ daemon_id, session_id })}
            onStartSession={(daemon_id, cwd) => hub.startSession(daemon_id, cwd)}
            onKillSession={(daemon_id, session_id) => hub.killSession(daemon_id, session_id)}
            startSessionErrors={startSessionErrors}
            onDismissStartSessionError={clearStartSessionError}
            pendingStartSessionByDaemon={pendingStartSessionByDaemon}
            pendingKillByKey={pendingKillByKey}
          />
```

In the `<SessionView>` invocation (L194-221), update the permission-related props:

```tsx
            <SessionView
              header={{
                name: selectedSession?.session_id ?? selected.session_id,
                model: selectedSession?.model ?? null,
                cwd: selectedSession?.cwd ?? "",
                online: sessionTimeline.online,
              }}
              items={sessionTimeline.items}
              composerBlocked={sessionTimeline.composerBlocked}
              pendingPermissionInThisSession={pendingPermissionInSelectedSession}
              pendingPermissionReply={pendingPermissionReply}
              onSendPermissionReply={
                pendingPermissionInSelectedSession
                  ? (decision) => sendPermissionReply(pendingPermissionInSelectedSession, decision)
                  : undefined
              }
              chatError={selectedChatError}
              connected={connected}
              idle={sessionTimeline.idle}
              hasMoreEarlier={sessionTimeline.hasMoreEarlier}
              historyLoading={sessionTimeline.historyLoading}
              historyTimedOut={sessionTimeline.historyTimedOut}
              maxOffset={sessionTimeline.maxOffset}
              unreadCount={sessionTimeline.unreadCount}
              pendingChatSend={pendingChatSend}
              slashEntries={selected ? selectSlashInventory(hub, selected.daemon_id, selected.session_id) : []}
              onMarkSeen={(offset) => markSeen(selected.daemon_id, selected.session_id, offset)}
              onLoadEarlier={sessionTimeline.loadEarlier}
              onSendChat={(content) => hub.sendChat(selected.daemon_id, selected.session_id, content)}
              onSendCliCommand={(text) => hub.sendCliCommand(selected.daemon_id, selected.session_id, text)}
              onBack={() => setSelected(null)}
              onDismissPendingCommand={dismissPendingCommand}
            />
```

(Note: `onOpenPermission={() => permissionQueue.openSurface()}` deleted; `onSendPermissionReply` added. `sessionTimeline.pendingInThisSession` was the old prop value — replaced with `pendingPermissionInSelectedSession` computed locally.)

Delete the entire `<PermissionSurface>` IIFE block (L253-271):
```tsx
      {permissionQueue.open && permissionQueue.active && (() => {
        const active = permissionQueue.active;
        return (
          <PermissionSurface ... />
        );
      })()}
```

Delete the handled-notice toast (L272-279):
```tsx
      {permissionQueue.handledNotice && (
        <div ... >
          Already handled on another device.
        </div>
      )}
```

- [ ] **Step 2: Edit `daemonViewModel.ts`**

Delete the `totalPendingApprovals` export at L130-137:
```ts
export function totalPendingApprovals(
  pendingPermissions: Record<string, PwaPermissionRequest>,
): number {
  return Object.keys(pendingPermissions).length;
}
```

The `PwaPermissionRequest` import may no longer be used directly — verify with `grep` and remove if unreferenced.

- [ ] **Step 3: Type-check the workspace**

Run: `bun --bun tsc --noEmit -p packages/pwa/tsconfig.json`
Expected: 0 errors. (If errors mention `useEffect` no longer used or `usePermissionQueue` import — remove the dead `useEffect`/import lines.)

Note: `useEffect` is still used elsewhere in the file (the appearance effect, the push-register effect) — keep that import.

- [ ] **Step 4: Run all PWA unit tests**

Run: `bun test packages/pwa`
Expected: PASS for all surviving tests. Failures may surface in `App.test.tsx` if it referenced removed props — address by removing the dead refs.

If `App.test.tsx` uses a real `<RealApp>` render and asserts on Bell or PermissionSurface, drop those assertions.

- [ ] **Step 5: Commit**

```bash
git add packages/pwa/src/RealApp.tsx packages/pwa/src/lib/daemonViewModel.ts
git commit -m "pwa: RealApp wires SessionView for inline permission card

Drops usePermissionQueue + PermissionSurface + topPendingPreview +
pendingApprovalsCount + handledNotice toast. Computes the active
session's pending permission inline and passes it as
pendingPermissionInThisSession + pendingPermissionReply +
onSendPermissionReply to SessionView.

totalPendingApprovals helper removed from daemonViewModel — its only
caller is gone."
```

---

### Task 6: Delete `usePermissionQueue` + `PermissionSurface` + their tests

**Files:**
- Delete: `packages/pwa/src/hooks/usePermissionQueue.ts`
- Delete: `packages/pwa/tests/usePermissionQueue.test.tsx`
- Delete: `packages/pwa/src/screens/PermissionSurface.tsx`
- Delete: `packages/pwa/tests/PermissionSurface.test.tsx`

- [ ] **Step 1: Delete the four files**

Run:
```bash
rm packages/pwa/src/hooks/usePermissionQueue.ts \
   packages/pwa/tests/usePermissionQueue.test.tsx \
   packages/pwa/src/screens/PermissionSurface.tsx \
   packages/pwa/tests/PermissionSurface.test.tsx
```

- [ ] **Step 2: Search for any lingering imports**

Run: `grep -rn "usePermissionQueue\|PermissionSurface" packages/pwa/src packages/pwa/tests 2>&1`
Expected: NO output (zero hits). If hits exist (likely in `DemoApp.tsx`), keep its self-contained `PermissionSurface`/`PermissionMiniCard` mock components (they're internal demo replicas, NOT imports of the deleted real ones — verify by reading the lines printed).

- [ ] **Step 3: Run all PWA tests**

Run: `bun test packages/pwa`
Expected: PASS — fewer test files than before but no failures.

- [ ] **Step 4: Type-check**

Run: `bun --bun tsc --noEmit -p packages/pwa/tsconfig.json`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add -A packages/pwa
git commit -m "pwa: delete usePermissionQueue, PermissionSurface, and their tests

The cross-session queue + 'handled by another device' state machine
no longer has a UI to drive — InlinePermissionCard handles each
session's pending request in isolation. Modal goes too."
```

---

### Task 7: Trim hub `PUSH_TOPICS` registry

**Files:**
- Modify: `packages/hub/src/push-topics.ts`
- Modify: `packages/hub/tests/push-topics-registry.test.ts`
- Modify: `packages/hub/tests/push-topics-payloads.test.ts`

- [ ] **Step 1: Update the registry tests first (TDD)**

Edit `packages/hub/tests/push-topics-registry.test.ts`:

```ts
import { test, expect } from "bun:test";
import { PUSH_TOPICS, getTopic } from "../src/push-topics.ts";

test("registry exposes the 2 active topics with stable ids", () => {
  expect(PUSH_TOPICS.map((t) => t.id).sort()).toEqual(
    ["idle", "permission"],
  );
});

test("permission is default-enabled and bypasses DND; idle is opt-in", () => {
  expect(getTopic("permission").default_enabled).toBe(true);
  expect(getTopic("permission").bypass_dnd).toBe(true);
  expect(getTopic("idle").default_enabled).toBe(false);
  expect(getTopic("idle").bypass_dnd).toBe(false);
});

test("getTopic throws on unknown id (including the legacy 'completed' / 'offline')", () => {
  expect(() => getTopic("nope")).toThrow(/unknown topic/);
  expect(() => getTopic("completed")).toThrow(/unknown topic/);
  expect(() => getTopic("offline")).toThrow(/unknown topic/);
});
```

Edit `packages/hub/tests/push-topics-payloads.test.ts`:

Delete the "offline payload renders hostname + duration" test (L20-28).
Delete the "completed payload renders daemon + session" test (L30-37).
Delete the "missing optional context fields default safely" test (L47-50) — its sole probe is `getTopic("offline")`.

The remaining file should hold only the permission and idle payload tests.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/hub/tests/push-topics-registry.test.ts packages/hub/tests/push-topics-payloads.test.ts`
Expected: FAIL — `PUSH_TOPICS` still has 4 entries.

- [ ] **Step 3: Edit `push-topics.ts`**

In `packages/hub/src/push-topics.ts`:

Delete the `OfflineCtx` type (L27).
Delete `offlineTopic` const (L52-70).
Delete `completedTopic` const (L72-90).
Replace the `PUSH_TOPICS` line (L112-114):

```ts
export const PUSH_TOPICS: ReadonlyArray<PushTopic> = [
  permissionTopic, idleTopic,
];
```

The `SessionCtx` interface stays — `idleTopic` still uses it. The `PermissionCtx` stays.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/hub/tests/push-topics-registry.test.ts packages/hub/tests/push-topics-payloads.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/push-topics.ts packages/hub/tests/push-topics-registry.test.ts packages/hub/tests/push-topics-payloads.test.ts
git commit -m "hub: drop completed and offline push topics

PUSH_TOPICS reduces to [permission, idle]. completed and idle fire
on the same end-of-turn event ~3s apart (completed immediately,
idle after idle_window) — keeping idle is enough. offline rarely
matters in the local-pairing model.

DB schema unchanged: push_subs.preferences keys 'completed:true' /
'offline:true' become inert (forward-compat per spec non-goal #3).
getTopic now throws on those legacy ids — callers in router.ts
will be removed in the next commit."
```

---

### Task 8: Remove `getTopic("completed")` + offline-timer block from hub `router.ts`

**Files:**
- Modify: `packages/hub/src/router.ts`

- [ ] **Step 1: Run hub tests to surface caller breakage**

Run: `bun test packages/hub`
Expected: FAIL inside `router.ts` paths — `getTopic("completed")` and `getTopic("offline")` now throw.

- [ ] **Step 2: Edit `router.ts`**

Remove fields and constants:

Replace L17-19:
```ts
const RING_BUFFER_SIZE = 200;
```
(remove `DEFAULT_OFFLINE_PUSH_DELAY_MS`.)

Replace L40-42:
```ts
export interface RouterOptions {}
```
(remove `offline_push_delay_ms`.)

Replace L44-58:
```ts
export class Router {
  private daemons = new Map<string, DaemonState>();

  constructor(
    private daemonReg: DaemonRegistry<unknown>,
    private pwaReg: PwaRegistry<unknown>,
    private db?: Db,
    private push?: PushHelper,
    _options: RouterOptions = {},
  ) {}
```
(remove `offlineTimers`, `offlineMeta`, `offlinePushDelayMs`, the `offlinePushDelayMs = options...` line.)

Replace the `case "hello"` block (L74-99). The cancel block at L75-78 goes:
```ts
      case "hello": {
        let display_name: string | null = null;
        if (this.db) {
          display_name = findDaemon(this.db, daemon_id)?.display_name ?? null;
        }

        const state: DaemonState = {
          daemon_id,
          hostname: frame.hostname,
          display_name,
          epoch: frame.epoch,
          sessions: new Map(frame.sessions.map((s) => [s.session_id, s])),
          events: [],
          pendingAskQuestions: new Map(),
          slashInventory: new Map(),
        };
        this.daemons.set(daemon_id, state);
        this.pwaReg.broadcast({
          type: "daemon_online", daemon_id, hostname: frame.hostname, display_name, sessions: frame.sessions,
        });
        return;
      }
```

Replace the `case "task_completed"` block (L202-215). Remove the `dispatchTopic(getTopic("completed"), …)`:
```ts
      case "task_completed": {
        const state = this.daemons.get(daemon_id);
        if (!state) return;
        this.pwaReg.broadcast({
          type: "task_completed",
          daemon_id,
          session_id: frame.session_id,
          ts: frame.ts,
        });
        return;
      }
```

Replace `onDaemonDisconnect` (L306-335) with the no-timer version:
```ts
  onDaemonDisconnect(daemon_id: string): void {
    const state = this.daemons.get(daemon_id);
    if (!state) return;
    this.daemons.delete(daemon_id);
    this.pwaReg.broadcast({ type: "daemon_offline", daemon_id });
  }
```

(`hostname` and `disconnected_at` locals are no longer needed.)

Now verify `dispatchTopic` import is still used — `permission` and `idle` cases still call it, so keep both `dispatchTopic` and `getTopic` imports.

- [ ] **Step 3: Run hub tests**

Run: `bun test packages/hub`
Expected: PASS for `push-topics-*`, `connections.test.ts`, etc. If `router`-touching tests fail mentioning `offline_push_delay_ms`, find them via:
```bash
grep -rn "offline_push_delay_ms\|offlineTimers\|offlineMeta" packages/hub/tests
```
and remove those references.

- [ ] **Step 4: Run full unit test suite**

Run: `bun test packages`
Expected: PASS for everything in `packages/*`.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/router.ts
git commit -m "hub: drop offline-timer + completed dispatch from router

onDaemonDisconnect simplifies to delete + daemon_offline broadcast.
The 30s setTimeout that fired the offline push (and its
offlineTimers / offlineMeta Maps + the cancel block in case 'hello')
is gone — no callers, no topic to dispatch to.

case 'task_completed' stops calling dispatchTopic(getTopic('completed'),
…) — completed topic was deleted in the previous commit. PWA still
gets the task_completed frame for its in-app counters."
```

---

### Task 9: Rewrite `e2e-real/tests/02-permission-relay.test.ts` for inline card

**Files:**
- Modify: `e2e-real/tests/02-permission-relay.test.ts`

- [ ] **Step 1: Edit the test file**

Edit `e2e-real/tests/02-permission-relay.test.ts`. The existing flow at L120-152 has six steps. Replace from "session-row-appears" through "permission-allowed" with an inline-card flow:

```ts
    await sc.step("session-row-appears", async () => {
      const sessionsList = session.page.getByTestId(`sessions-${daemon_id}`);
      await sessionsList.locator(".bg-surface").first().waitFor({ timeout: 30_000 });
    });

    await sc.step("session-opened", async () => {
      const sessionsList = session.page.getByTestId(`sessions-${daemon_id}`);
      await sessionsList.locator(".bg-surface").first().click();
      await session.page.getByTestId("session-view").waitFor({ timeout: 5_000 });
    });

    await sc.step("inline-permission-card", async () => {
      // After the redesign, the pending permission renders directly inside
      // the selected session's timeline — no global mini-card, no modal.
      const card = session.page.getByTestId("inline-permission-card");
      await card.waitFor({ timeout: 30_000 });
      // Card carries the request_id as data attribute and shows the command.
      await expect(card).toContainText(argsSummary);
      await expect(card).toContainText("Bash");
    });

    await sc.step("permission-allowed", async () => {
      await session.page
        .getByTestId("inline-permission-card")
        .getByRole("button", { name: /Allow once/ })
        .click();
      // Card unmounts when the reducer drops the permission_request.
      await expect(session.page.getByTestId("inline-permission-card")).toHaveCount(0, {
        timeout: 10_000,
      });
    });
```

The "tool-result-rendered" step (L154-164) stays unchanged.

- [ ] **Step 2: Spot-run the modified test (requires docker compose up)**

Run from a shell where docker is running:
```bash
cd e2e-real && bun playwright test tests/02-permission-relay.test.ts --reporter=line
```
Expected: PASS. If the harness can't start (preflight fails), defer execution to CI but make sure the file at least type-checks: `bun --bun tsc --noEmit -p e2e-real/tsconfig.json`.

- [ ] **Step 3: Commit**

```bash
git add e2e-real/tests/02-permission-relay.test.ts
git commit -m "e2e-real: rewrite 02-permission-relay for inline card flow

Drop the home mini-card hop and the modal-based 'Review' click.
After the redesign there's no PermissionSurface to open — the card
lives inside the session timeline. Test now: open session → inline
card visible with the command → click Allow once → card unmounts.
tool-result-rendered step is unchanged."
```

---

### Task 10: Rewrite `e2e-real/tests/03-permission-deny.test.ts` for inline card

**Files:**
- Modify: `e2e-real/tests/03-permission-deny.test.ts`

- [ ] **Step 1: Edit the test file**

In `e2e-real/tests/03-permission-deny.test.ts`, replace the steps from "permission-mini-card" through "tool-failure-rendered" (L95-121) with:

```ts
    await sc.step("inline-permission-card", async () => {
      const card = session.page.getByTestId("inline-permission-card");
      try {
        await card.waitFor({ timeout: 60_000 });
      } catch {
        // tmux'd Claude can boot slowly on cold caches; nudging the page often
        // unsticks a stalled SSE connection. Re-navigate to home and back into
        // the session, then re-wait.
        await session.page.goto("/");
        await session.page.getByTestId(`machine-card-${daemon_id}`).waitFor({ timeout: 30_000 });
        const sessionsList = session.page.getByTestId(`sessions-${daemon_id}`);
        await sessionsList.locator(".bg-surface").first().click();
        await card.waitFor({ timeout: 30_000 });
      }
    });

    await sc.step("permission-denied", async () => {
      await session.page
        .getByTestId("inline-permission-card")
        .getByRole("button", { name: /^Deny$/ })
        .click();
      // Card unmounts after Deny is acked.
      await expect(session.page.getByTestId("inline-permission-card")).toHaveCount(0, {
        timeout: 10_000,
      });
    });

    await sc.step("session-still-healthy", async () => {
      // After Deny: card gone, no other PermissionSurface modal exists, and the
      // session timeline still renders.
      await expect(session.page.getByTestId("inline-permission-card")).toHaveCount(0);
      await session.page.getByTestId("timeline").waitFor({ timeout: 30_000 });
    });
```

- [ ] **Step 2: Spot-run if docker is up**

Run: `cd e2e-real && bun playwright test tests/03-permission-deny.test.ts --reporter=line`
Expected: PASS or environmentally-skipped. Type-check at minimum.

- [ ] **Step 3: Commit**

```bash
git add e2e-real/tests/03-permission-deny.test.ts
git commit -m "e2e-real: rewrite 03-permission-deny for inline card flow

Same as scenario 02: no mini-card, no Review hop, no modal — open
session → inline card → click Deny → card unmounts → timeline still
renders (session healthy)."
```

---

### Task 11: Delete obsolete e2e tests (multi-pending queue + offline push)

**Files:**
- Delete: `e2e-real/tests/15-multi-pending.test.ts`
- Delete: `e2e-real/tests/21-push-topics.test.ts`

- [ ] **Step 1: Confirm scenario 15 tests behavior we removed**

Run: `grep -n "permission-queue\|Already handled on another device\|1 of 2 pending\|Review" e2e-real/tests/15-multi-pending.test.ts | head`
Expected: matches present (queue + handled-notice + Review button) — every assertion in the file relies on the deleted UI.

- [ ] **Step 2: Confirm scenario 21 tests offline-topic dispatch**

Run: `grep -n "offline\|completed" e2e-real/tests/21-push-topics.test.ts | head`
Expected: matches present (the entire test asserts the offline subscription end-to-end pipeline).

- [ ] **Step 3: Delete both files**

Run:
```bash
rm e2e-real/tests/15-multi-pending.test.ts e2e-real/tests/21-push-topics.test.ts
```

- [ ] **Step 4: Confirm scenario 11 (offline-push.test.ts) is unaffected**

Despite its name, scenario 11 tests `/push/subscribe` registration only — see its file-level comment block. Read the first 15 lines:
```bash
head -15 e2e-real/tests/11-offline-push.test.ts
```
Expected: comment block stating "subscription REGISTRATION only — settings-drawer push toggles are covered by scenario 13. The original push.ts short-circuits when VITE_VAPID_PUBLIC_KEY is unset…" — so no change needed.

- [ ] **Step 5: Commit**

```bash
git add -A e2e-real/tests
git commit -m "e2e-real: delete 15-multi-pending and 21-push-topics

15: cross-session permission queue + 'Already handled on another
device.' toast no longer exist — non-goal per the redesign spec.

21: offline-topic dispatch end-to-end pipeline is gone with the
topic itself. Hub-side topic registry is covered by
push-topics-registry.test.ts; dispatch contract by
push-dispatch.test.ts."
```

---

### Task 12: Manual end-to-end smoke via demo

**Files:** none modified — this task captures pre-PR verification screenshots.

- [ ] **Step 1: Bring up the demo**

Run: `./tools/demo-channel.sh up` (per `docs/operations/local-debug-environment.md` §1).

- [ ] **Step 2: Open the PWA, sign in, drive a permission request**

In a browser:
1. http://localhost:15173/ — sign in via fake-IAS.
2. `tmux attach -t demo-claude` — type a prompt that triggers a Bash tool call (e.g., `touch /tmp/cc-remote-demo/scratch.txt && rm it`).
3. In the PWA Home, observe the affected session card: 2px warning left border, "permission needed (Bash)" line above cwd. No Bell icon in header or rail.
4. Click into the session — `<InlinePermissionCard>` renders at the top of the timeline with the `$ rm …` code block, "Allow once" / "Deny" buttons, "Permission" pill + tool name + truncated request_id.
5. Click Allow once. The card should unmount within ~1s. Tool output renders below.

- [ ] **Step 3: Capture before/after screenshots**

Use any screenshot tool. Include in the PR description:
- Home with one waiting session.
- Session view with the inline card visible.
- Session view after Allow (card gone, tool output rendering).

- [ ] **Step 4: Tear down**

Run: `./tools/demo-channel.sh stop`

- [ ] **Step 5: Commit (only if any PR-description artifacts land in the repo — usually not)**

Skip if no files changed. Otherwise:
```bash
git add docs/superpowers/specs/2026-05-29-permission-notification-redesign.md
git commit -m "docs: link redesign PR screenshots into spec"
```

---

## Self-Review

### Spec coverage

| Spec section | Covered by |
|---|---|
| §4.1 delete `usePermissionQueue` | Task 6 |
| §4.1 delete `PermissionSurface` | Task 6 |
| §4.1 RealApp drops topPending/topPendingPreview/permissionQueue/handledNotice | Task 5 |
| §4.1 AppShell drops Bell + props | Task 3 |
| §4.2 add InlinePermissionCard | Tasks 1, 2 |
| §4.3 SessionView modify + props | Task 2 |
| §4.4 HomeScreen SessionRow polish | Task 4 |
| §4.5 SettingsDrawer 2 toggles | **No code change needed** — topic list is server-driven via `/push/topics`; trimming `PUSH_TOPICS` (Task 7) makes the UI render 2 toggles automatically. Captured in plan header "Architecture" section + manual verification in Task 12. |
| §5.1 push-topics.ts | Task 7 |
| §5.2 router.ts (task_completed dispatch + offline-timer) | Task 8 |
| §5.3 schema.ts views | **Not applicable** — spec misread schema; the L90/L94 references are one-shot v3 migration INSERTs, not views. Per spec §2 non-goal #3 (no DB migration), `schema.ts` stays untouched. Documented in Task header. |
| §5.4 forward-compat | Implicit — no schema change preserves it. |
| §6 unit (PWA) InlinePermissionCard.test | Task 1 |
| §6 unit (proto/hub) push-topics test | Task 7 |
| §6 e2e-real 02 + 03 rewrites | Tasks 9, 10 |
| §6 manual playwright probe | Task 12 |

### Placeholder scan

No "TBD", "TODO", "implement later", "appropriate error handling", or "similar to Task N" in the plan. Every step has the actual code or the actual command.

### Type consistency

- `InlinePermissionCardProps` (Task 1) → consumed unchanged by `SessionView` (Task 2).
- `onSendPermissionReply: (decision) => void` consistent in `SessionViewProps` (Task 2) and the `<SessionView>` invocation in `RealApp` (Task 5).
- `pendingPermissionInThisSession` prop name consistent across SessionView, RealApp.
- `PUSH_TOPICS` array element types unchanged (Task 7) — `PushTopic` interface still exported, callers in `routes.ts` (`PUSH_TOPICS.map((t) => …)`) iterate fine.

### Scope check

The plan ships in a single PR per spec §8. The 12 tasks group into 3 logical clusters (PWA delete+add, hub topic prune, e2e tests) but are interdependent — task 5's RealApp wiring assumes Tasks 1-4 are merged. Subagent-driven execution is appropriate; do tasks in order.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-29-permission-notification-redesign.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
