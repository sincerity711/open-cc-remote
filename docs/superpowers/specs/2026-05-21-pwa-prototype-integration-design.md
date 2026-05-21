# PWA Prototype Integration — Design

Status: draft
Date: 2026-05-21
Owner: PWA team

## Goal

Wire the new PWA prototype (`packages/pwa/src/App.tsx`, shadcn/Tailwind 4, 20-card timeline catalog) into the live cc-remote product so the prototype's UI replaces the existing inline-styled `RealApp.tsx` while reusing the current hub WebSocket protocol, IAS auth, push notifications, and device-management APIs unchanged.

The current `App.tsx` is a guided demo (device pills + Next stepper + static fixtures). The integration:

- Keeps the demo accessible at `/demo` for visual reference / regression
- Extracts a shared `screens/` layer that both the demo and the live app drive
- Replaces the live UI piece-by-piece (PR-per-stage), keeping `bun test e2e/` green at every step

Decisions locked during brainstorming:

- Demo wrapper kept on `/demo` route (live UI is clean)
- Session view = single timeline merging chat + JSONL events
- Permission UX = prototype's pattern (HomeScreen mini-card → dedicated decision surface; mobile bottom-sheet, tablet centered modal, desktop right-rail aside)
- Event rendering = full mapping with raw fallback
- Architecture = shared `screens/` layer; demo and real both consume it
- Timeline rendering uses `SessionExecutionTimeline` / `SessionTimelineItem` style (5 markers + left rail + Catalog\* cards). The orphan `EventTimeline` / `TimelineShell` / `TimelineEventCard` path is dead code and gets deleted during integration.

## §1 — Architecture and Directory Layout

```
packages/pwa/src/
├── components/
│   ├── ui/                       # shadcn primitives (button.tsx exists; add input/sheet/dialog as needed)
│   └── screens/                  # pure presentational layer; takes props, no WS/auth imports
│       ├── AppShell.tsx          # AppHeader + DesktopNav + responsive grid skeleton
│       ├── HomeScreen.tsx        # PermissionMiniCard + DaemonCard[] + OfflineDaemonCard
│       ├── SessionView.tsx       # session header + SessionTimeline + Composer
│       ├── PermissionSurface.tsx # mobile bottom-sheet / tablet modal / desktop aside
│       ├── SettingsDrawer.tsx    # Account / Devices / Pair / Notifications / Appearance
│       ├── SignInScreen.tsx
│       ├── timeline/
│       │   ├── SessionTimeline.tsx       # rail + scroll + load-earlier
│       │   ├── SessionTimelineItem.tsx   # marker(claude|user|tool|success|idle) + content slot
│       │   ├── cards/
│       │   │   ├── CatalogCard.tsx       # generic shell, 5 tones
│       │   │   ├── CatalogHeader.tsx     # icon + title + meta + status
│       │   │   ├── UserBubble.tsx
│       │   │   ├── AssistantBubble.tsx
│       │   │   ├── ReasoningCard.tsx
│       │   │   ├── BashToolCard.tsx
│       │   │   ├── FileEditCard.tsx
│       │   │   ├── ReadSearchCard.tsx
│       │   │   ├── ToolResultShortCard.tsx
│       │   │   ├── ToolResultLongCard.tsx
│       │   │   ├── ToolFailureCard.tsx   # also used for `error` kind
│       │   │   ├── PermissionInlineCard.tsx
│       │   │   ├── PermissionResolvedCard.tsx
│       │   │   ├── BatchSummaryCard.tsx
│       │   │   ├── SubagentCard.tsx      # collapsed + expanded in one component
│       │   │   ├── TaskCreatedCard.tsx
│       │   │   ├── TaskCompletedCard.tsx
│       │   │   ├── SystemNoticeCard.tsx  # system | compact | session-boundary | metadata
│       │   │   ├── IdleWaitingCard.tsx
│       │   │   ├── RawJsonCard.tsx
│       │   │   └── index.ts              # barrel
│       │   └── renderTimelineItem.tsx    # event.kind → marker + Card selection
│       └── primitives/
│           ├── ClaudeCodeMark.tsx
│           ├── StatusChip.tsx
│           ├── StatusIcon.tsx
│           └── Field.tsx
├── demo/
│   ├── DemoApp.tsx               # current App.tsx wrapper (GuideRail + DevicePills + Next)
│   ├── CardsCatalogPage.tsx      # current Cards step, reuses cards/* via barrel
│   └── fixtures.ts               # current sessions/timelineEvents/sessionPreviewEvents
├── app/
│   └── RealApp.tsx               # useHub/useAuth/useDevices → screens/*
├── hooks/
│   ├── useHub.ts                 # current ws.ts renamed
│   ├── useAuth.ts                # current auth.ts wrapped
│   ├── useDevices.ts             # current api.ts (devices + pushPrefs) wrapped
│   └── useSessionTimeline.ts     # derives merged TimelineEvent[] for the selected session
├── lib/
│   ├── timeline.ts               # mergeTimeline(events, chat, ...) → TimelineEvent[]
│   └── utils.ts                  # cn (existing)
├── App.tsx                       # /demo → DemoApp; otherwise → RealApp
└── main.tsx
```

Key invariants:

1. `screens/timeline/cards/*` is consumed by both the live `SessionView` and the demo `CardsCatalogPage`. The catalog page is a grid of all variants for visual review; the live view picks variants per timeline item.
2. The 14 `TimelineEvent.kind` values map to 5 `SessionTimelineItem` markers in `renderTimelineItem.tsx`:
   - `user` → marker:user
   - `assistant`, `thinking` → marker:claude
   - `tool`, `permission-inline`, `subagent`, `batch`, `task` (status=created) → marker:tool
   - `permission-resolved`, `task` (status=completed) → marker:success
   - `system`, `compact`, `session-boundary`, `metadata`, `error`, `raw` → marker:idle

   Idle handling is NOT a `TimelineEvent.kind`. The hub's `idle` frame sets `idleSessions[k] = true` (session-level flag, not a payload). When the flag is set for the active session, `SessionView` appends a synthetic last item rendered via `IdleWaitingCard` outside `renderTimelineItem`. Cleared as soon as any new event arrives.
3. A `tool` event picks its specific card by `tool.name + result + output length`:
   - Bash → `BashToolCard`
   - Read/Grep/Glob → `ReadSearchCard`
   - Edit/Write → `FileEditCard`
   - `result==='failure'` → `ToolFailureCard`
   - success + output ≤ 2 lines → `ToolResultShortCard`
   - success + longer output → `ToolResultLongCard`
4. v1 renders one timeline item per event (streaming style). The "Claude turn" aggregation (assistant text + nested tool calls in one card) shown in the prototype's `SessionClaudeTurnCard` is a v2 follow-up.
5. `App.tsx` routes by `location.pathname.startsWith('/demo')`. No `react-router` dependency.
6. `error` kind reuses the `ToolFailureCard` shell with mapped title/detail.

## §2 — Data Flow

### 2.1 Hub signals (unchanged protocol)

```
                                     ┌── snapshot / daemon_online / daemon_offline / session_open / session_close
                                     │      → daemons: DaemonView[]
                                     │
                                     ├── event (jsonl payload)
                                     │      → events[k]: EventFrameForPwa[]
                                     │
   Hub WS  ──  HubToPwa  ──────────  ┼── chat
                                     │      → chatMessages[k]: PwaChatBroadcast[]
                                     │
                                     ├── permission_request / permission_resolved
                                     │      → pendingPermissions: Record<request_id, ...>
                                     │
                                     ├── task_completed / idle
                                     │      → completedCounts[k] / idleSessions[k]
                                     │
                                     └── chat_error
                                            → chatErrors[k]

   k = `${daemon_id}::${session_id}` (current `eventKey`, unchanged)
```

### 2.2 Derivation layer `lib/timeline.ts` (new, pure function)

```ts
export function mergeTimeline(args: {
  events: EventFrameForPwa[];
  chat: PwaChatBroadcast[];
  pending: PwaPermissionRequest[];     // pending requests for THIS session
  resolved: PwaPermissionResolved[];   // resolved within current connection
}): TimelineEvent[]
```

Kind inference rules (jsonl payload → `TimelineEvent.kind`):

| Source payload | Inferred kind |
|---|---|
| chat broadcast (`from === 'pwa'`) | `user` |
| chat broadcast (`from === 'claude'`) | `assistant` |
| jsonl `text_delta` accumulated | merged into preceding `assistant` (same turn) |
| jsonl `thinking` block | `thinking` |
| jsonl `tool_use` (Bash/Read/Edit/Write/Grep/Glob) | `tool` |
| jsonl `tool_result` | merged into the matching `tool` (sets result/output) |
| `permission_request` frame | `permission-inline` (also placed in `pendingPermissions`) |
| `permission_resolved` frame | `permission-resolved` |
| jsonl `session_start` / `cwd_change` / `compact` / `model_change` | `system` / `metadata` / `compact` / `session-boundary` |
| jsonl `task_created` | `task` (status=created) |
| `task_completed` frame | `task` (status=completed) |
| jsonl with `subagent_id` | `subagent` (children grouped by id) |
| jsonl with non-zero exit / hook PostToolUseFailure | `error` |
| anything else | `raw` |

v1 coverage: `user / assistant / tool / permission-inline / permission-resolved / system / metadata / compact / session-boundary / error / raw / task(created+completed) / idle`. `thinking` / `subagent` / `batch` fall through to `raw` until daemon-side surfaces those fields (UI is ready; data path is the gap).

`mergeTimeline` is a pure function — fully unit-testable, lives in `lib/`, no React.

### 2.3 Hooks

```ts
// hooks/useHub.ts (renamed from ws.ts; surface largely unchanged)
export function useHub(hubUrl: string, bearer: string | null): UseHubResult { ... }

// hooks/useSessionTimeline.ts (new, derived on top of useHub)
export function useSessionTimeline(
  hub: UseHubResult,
  selected: { daemon_id: string; session_id: string } | null,
): {
  items: TimelineEvent[];
  loadEarlier: () => void;            // throttled via existing requestHistory
  composerBlocked: boolean;           // session has any pending permission
  online: boolean;
}
```

### 2.4 Screen prop shapes (no hook imports inside `screens/`)

```ts
// HomeScreen
{
  daemons: DaemonViewModel[];
  pendingApprovalsCount: number;
  topPendingPreview?: { daemonHostname; sessionName; tool; commandSummary };
  onSelectSession: (daemon_id, session_id) => void;
  onStartSession: (daemon_id, cwd) => void;
  onKillSession: (daemon_id, session_id) => void;
  onOpenPermission: () => void;
  onOpenSettings: () => void;
}

// SessionView
{
  header: { name; model; cwd; online };
  items: TimelineEvent[];
  composerBlocked: boolean;
  pendingPermissionInThisSession?: PwaPermissionRequest;
  onLoadEarlier: () => void;
  onSendChat: (content: string) => void;
  onOpenPermission: (request_id) => void;
  onBack: () => void;                  // mobile only
}

// PermissionSurface
{
  request: PwaPermissionRequest;
  queueSize: number;                   // "1 of 3 pending"
  onAllow: () => void;
  onDeny: () => void;
  onClose: () => void;
  device: 'mobile' | 'tablet' | 'desktop';
}

// SettingsDrawer
{
  account: { email; signOut: () => void };
  devices: DeviceItem[];
  onRenameDevice / onRevokeDevice / onClose;
  pushPrefs: PushPreferences;
  onTogglePref: (key: 'permission' | 'offline' | 'completed' | 'idle') => void;
  pairingCode?: { code; expiresInSec };  // see §2.5; v1 always undefined
  appearance: 'system' | 'light' | 'dark';
  onSetAppearance: (mode) => void;
}
```

### 2.5 Gaps where the prototype shows what the product does not have

| Prototype shows | v1 handling |
|---|---|
| Settings → "Pair new daemon" with 6-digit code + countdown | Hub does not generate pairing codes from the PWA path (current flow: `cc-remote pair` CLI). Render the section as a **UI placeholder**: keep prototype layout, replace code/countdown with `— —`, add a hint "Run `cc-remote pair` on your machine" + a `Copy command` button. No pairing API call. |
| Historical `permission-resolved` items when scrolling back | Hub does not persist resolved frames; only the live broadcast is observable. v1 renders only `permission_resolved` frames received during the active connection. Re-rendering historical resolutions on scrollback is a v2 follow-up gated on daemon persistence. |

### 2.6 Demo path data

`demo/fixtures.ts` exports `sessions` / `timelineEvents` / `sessionPreviewEvents` shaped as `DaemonViewModel[]` / `TimelineEvent[]`. `DemoApp` passes them directly to `screens/*`. Zero runtime branching inside screens.

## §3 — Edge States, Errors, Responsive Behavior

### 3.1 Responsive layout (no manual device switcher in production)

The live app derives layout from viewport width via Tailwind breakpoints. No JS device state.

| Breakpoint | Layout |
|---|---|
| `< 768px` (mobile) | Single column. HomeScreen and SessionView mutually exclusive (tap session → push; back button → pop) |
| `768–1023px` (tablet) | Two columns: HomeScreen 320px + SessionView flex. When no session is selected, the SessionView column shows an empty-state panel ("Select a session to start"). |
| `≥ 1024px` (desktop) | Three columns: DesktopNav 72px + HomeScreen 370px + SessionView flex. Empty-state panel as on tablet. |

`useMediaQuery` is used **only** for `PermissionSurface` (which changes DOM structure between bottom-sheet / modal / aside) — pure CSS cannot swap structures.

The `/demo` path keeps device pills + fixed prototype frame sizes. That is its purpose.

### 3.2 Connection / online state

| Signal | UI |
|---|---|
| `connected === true` | AppHeader chip `tone=online label="Connected"` |
| `connected === false` | AppHeader chip `tone=error label="Reconnecting…"`. SessionView shows a banner above the composer: "Connection lost — messages will retry when reconnected". Composer remains enabled; messages are queued in component state and flushed on reconnect. No client-side message_id (hub-side dedup is sufficient for v1). |
| daemon `online === false` | DaemonCard at reduced opacity (existing). Sessions show offline tone. SessionView header chip = Offline. Composer disabled, placeholder = "session offline". |
| Selected session not in `daemon.sessions` (killed remotely) | SessionView shows a red strip "Session ended" with a Close button. |

### 3.3 Permission UX details

| Condition | Behavior |
|---|---|
| `pendingPermissions` empty | No mini-card on Home; no inline warning in Session; composer normal |
| Pending exists for **this** session | Inline `permission-inline` card in timeline + warning strip above composer + composer disabled + Review button opens `PermissionSurface` |
| Pending exists for **another** session | HomeScreen `PermissionMiniCard` shows `N approvals waiting` with the oldest as preview |
| Multiple pending | `PermissionSurface` shows `1 of N pending`. After Allow/Deny, automatically advances to the next pending request. |
| Resolved by another device | Hub broadcasts `permission_resolved`. Client detects request_id no longer in `pendingPermissions`, closes the surface, shows a transient "Already handled on another device" notice. |

### 3.4 Timeline edges

| Scenario | Behavior |
|---|---|
| Empty session (events=0, chat=0) | Centered hint "Send a message to start" |
| Scrolled to top | Auto `loadEarlier()` (throttled 500ms, existing logic). Plus an explicit `Load earlier events` button at the top for discoverability/a11y. |
| New event while user has scrolled up | Preserve scroll position (existing `autoScroll` flag). Show floating `New events ↓` button to jump back. |
| Unrecognized payload | `raw` kind → `RawJsonCard`, expandable JSON. |
| Tool event with no `tool_result` yet | `result === 'running'`, spinning loader, summary "Running…", duration counter ticking `mm:ss`. No timeout error (tools can be slow). |
| Multiple `tool_use` in one turn | v1: each rendered as its own item. No batch aggregation. |

### 3.5 IAS login / bearer expiry

| Signal | Behavior |
|---|---|
| No bearer | Render `SignInScreen`. CTA → `loginUrl(HUB_URL)`. |
| Login redirect fragment present | `consumeFragment()` runs in RealApp top-level effect (unchanged). |
| WS receives auth-failure close (e.g. 401-equivalent close code) | `clearBearer()` + force back to `SignInScreen` + transient toast "Session expired, please sign in again". |
| Device revoked on hub | Same path — WS closes, fallback into SignInScreen. |
| Reconnect storm risk | If 3 consecutive WS opens close immediately with auth failure, clear bearer and stop retrying. Avoids infinite reconnect loop on stale bearer. |

### 3.6 Push notifications

Reuses existing `push.ts` + 4 toggles. Renders the toggles using the prototype `ToggleRow` style (each shows `On` / `Off` chip). Registration flow unchanged; only the Settings markup is replaced.

## §4 — Migration Plan

Each milestone is a single PR, independently revertible, with the in-process `bun test e2e/` suite green at every step.

| Milestone | Scope | Acceptance |
|---|---|---|
| **M1 Skeleton split** | Move current `App.tsx` to `demo/DemoApp.tsx`. New `App.tsx` routes by path. `/` → existing `RealApp.tsx` unchanged; `/demo` → `DemoApp`. | Live behavior unchanged. `/demo` reachable. e2e green. |
| **M2 Primitives + ui** | Extract `ClaudeCodeMark`, `StatusChip`, `StatusIcon`, `Field`, `CatalogCard`, `CatalogHeader` from `DemoApp` into `screens/primitives` and `screens/timeline/cards/`. DemoApp imports them. | typecheck pass. `/demo` visually identical. |
| **M3 Timeline cards** | Each of the 20 catalog cards moves to its own file under `screens/timeline/cards/`. Add `cards/index.ts` barrel. Implement `renderTimelineItem.tsx`. Cards step in DemoApp imports from barrel. | `/demo` Cards step visually identical. |
| **M4 SessionView wired** | Build `screens/SessionView.tsx`, `lib/timeline.ts mergeTimeline`, `hooks/useSessionTimeline`. RealApp swaps its `<SessionPane>` to `<SessionView>`. `HomePane` still inline-styled. | `e2e-real`: chat / permission / kill-session / history scenarios pass. |
| **M5 HomeScreen + AppShell** | Replace RealApp's daemon list and header with `AppShell` + `HomeScreen`. Wire `pendingPermissions` into `PermissionMiniCard`. | All 12 e2e-real scenarios pass. Manual visual check on mobile/tablet/desktop. |
| **M6 PermissionSurface** | Wire single + multi-pending. Delete `PermissionBanner.tsx`. `useMediaQuery` selects surface form. Implement "already handled" auto-close. | Permission e2e-real scenarios pass; multi-pending manual check. |
| **M7 SettingsDrawer** | Replace `Settings.tsx`: 4 push toggles + device list rename/revoke + Pair UI placeholder + Appearance tri-state. | Push-prefs API calls unchanged. |
| **M8 SignInScreen + auth fallbacks** | Replace "not signed in" branch with `SignInScreen`. Add 3-consecutive-401 bearer-clear guard. | Bearer-less load → SignInScreen. Callback flow unchanged. |
| **M9 Cleanup** | Delete remaining inline-style code in RealApp; delete `SessionPane.tsx`, `PermissionBanner.tsx`, old `Settings.tsx`. Rename `ws.ts → hooks/useHub.ts`, `auth.ts → hooks/useAuth.ts`, `api.ts → hooks/useDevices.ts`. `App.tsx` is just routing. | typecheck + unit + e2e + e2e-real all green. Visual QA. |

After M9, tag `plan-pwa-prototype-integration`.

### 4.1 Test strategy

| Layer | Status | Additions |
|---|---|---|
| `bun test packages/` (169 tests) | Pure unit | Add tests for `lib/timeline.ts mergeTimeline` covering each kind, multi-tool turns, history merge dedup, unknown payloads → raw. Add snapshot tests for `renderTimelineItem` across 13 kinds. |
| `bun run typecheck` | 6 packages | `screens/` introduces `TimelineEvent` and `DaemonViewModel`. Strict mode preserved. |
| `bun test e2e/` (in-process) | fake-claude harness, merge gate | Stable selectors must be preserved on the new components: `data-testid="conn-status"`, `chat-input`, `chat-log`, `sessions-${daemon_id}`. New testids: `timeline`, `permission-surface`, `composer`, `machine-card-${daemon_id}`. |
| `bun test e2e-real/` | 12 scenarios via real `claude` + tmux + docker | Becomes browser-driven via Playwright with screenshot/video archival — see §4.5. |

### 4.2 Compatibility constraints

- Unchanged: `@cc-remote/proto` types; hub frame shapes; `/ws/pwa` protocol; existing e2e `data-testid` names.
- Changed: PWA internal directory layout; `/` visual; new `/demo` route.

### 4.3 Out of scope (explicit follow-ups, not in v1)

- Real data wiring for `thinking` / `subagent` / `batch` (UI is ready; daemon-side payload exposure is the gap)
- "Claude turn" aggregation card (assistant text + nested tools as one card)
- Historical `permission_resolved` re-render on scrollback (needs daemon persistence)
- Pairing initiated from PWA (needs a new hub endpoint)
- Appearance persistence + system-theme follow

## §4.5 — e2e-real Visual Capture Overhaul

### 4.5.1 Playwright replaces WS-only client for scenarios

Today `helpers/pwa-client.ts` walks the IAS redirect chain manually and opens a bare WebSocket — no browser, no UI. To capture screenshots and video, scenarios drive a real browser.

- New `helpers/pwa-browser.ts` using Playwright. PWA served by `vite preview` (host or compose). SSO flow goes through the browser; IAS demo mode bypasses the user prompt.
- `pwa-client.ts` is kept as a tool for protocol-only assertions (e.g. `10-perm-p95.test.ts` measuring permission round-trip latency where a browser would add noise). Not deleted.
- All 12 `tests/*.test.ts` rewritten to use the browser path and `page.locator` assertions.

### 4.5.2 Key-frame screenshots (convention-driven)

Each scenario wraps actions in `scenario.step(label, async () => { ... })`, defined in `helpers/scenario.ts`. The wrapper auto-captures a screenshot when the step body resolves. Filenames: `${seq}-${slug(label)}.png`.

```ts
// 02-permission-relay.test.ts
await scenario.step("home-after-login",       () => page.goto(...));
await scenario.step("session-opened",         () => clickSession());
await scenario.step("permission-banner-mini", () => waitFor("[data-testid=permission-mini]"));
await scenario.step("permission-surface",     () => clickReview());
await scenario.step("permission-allowed",     () => clickAllow());
await scenario.step("session-resumed",        () => waitForToolResult());
```

Step labels are stable identifiers across runs — they are the visual-regression surface area.

### 4.5.3 Video and trace

Playwright's built-in capture:

```ts
const context = await browser.newContext({
  recordVideo: { dir: artifactsDir },
  recordHar: false,
});
await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
// ... scenario ...
await context.tracing.stop({ path: `${artifactsDir}/trace.zip` });
```

Both pass and fail runs retain video + trace. Trace is openable in `npx playwright show-trace trace.zip`.

### 4.5.4 Archive directory layout

```
e2e-real/
├── artifacts/                          # gitignored
│   └── <run-timestamp>/                # e.g. 2026-05-21T10-32-04Z
│       ├── _summary.json               # { runId, gitSha, branch, scenarios: [...] }
│       ├── 01-pair-and-snapshot/
│       │   ├── trace.zip
│       │   ├── video.webm
│       │   ├── 01-home-after-login.png
│       │   └── ...
│       └── ...
└── screenshots/                        # tracked in git
    └── <scenario>/
        ├── 01-home-after-login.png     # overwritten on each successful run
        └── ...
```

- `artifacts/` is fully gitignored (videos and traces are large; per-run timestamped dirs accumulate).
- After a successful scenario, the runner copies that scenario's PNGs into `screenshots/<scenario>/`. Failed scenarios skip the copy (avoids overwriting good baselines with bad images).
- Visual regression workflow: review `git diff e2e-real/screenshots/` before merging — any PNG change is a deliberate visual update or an unintended regression.

### 4.5.5 Visual regression policy (v1: human review)

- v1: reviewer eyeballs `git diff` of `screenshots/`. Any PNG byte-changed is up for inspection.
- No pixel-diff tooling, no baseline lock. Environment jitter (font rendering, antialiasing) would produce false positives.
- Video and trace are post-hoc debugging aids, not assertion inputs.

### 4.5.6 Three-end viewport coverage

Per-scenario default: desktop 1280×800. A wrapper enables multi-viewport runs:

```ts
forEachViewport(["mobile-390x844", "tablet-768x1024", "desktop-1280x800"], (vp) => {
  scenario(`${name}@${vp}`, ...);
});
```

v1 multi-viewport applies to typical-path scenarios only: `01-pair-and-snapshot`, `02-permission-relay`, `12-chat-roundtrip`. Others remain desktop-only — running 12 × 3 = 36 would cost too much wall time. Multi-viewport screenshots include a viewport suffix: `02-session-opened.mobile.png`.

### 4.5.7 Run ergonomics

```bash
bun test e2e-real/                                       # default (desktop only)
RUN_VIEWPORTS=mobile,tablet,desktop bun test e2e-real/   # typical paths × 3 viewports
ARCHIVE=0 bun test e2e-real/                             # skip artifacts (CI fast path)
```

`ARTIFACTS_DIR` env defaults to `e2e-real/artifacts`. CI may redirect to a build-bot path for upload.

### 4.5.8 Phased delivery

| Phase | Scope |
|---|---|
| **V1** | `pwa-browser.ts` + `scenario.ts` (step + screenshot + video). Rewrite `01-pair-and-snapshot`, `02-permission-relay`, `12-chat-roundtrip`. |
| **V2** | Rewrite remaining 9 scenarios. |
| **V3** | Multi-viewport wrapper; enable mobile/tablet for typical paths. |
| **V4** | `_summary.json`; sync-on-success → `screenshots/<scenario>/`; `.gitignore` of `artifacts/`. |

V1 can land before the PWA integration milestones — running against current `RealApp.tsx`. From M4 onward, the screenshots naturally reflect the new UI as it lands.

## Open questions

None as of this draft. Ambiguities resolved in brainstorming:

1. Demo wrapper → `/demo` route
2. Session view → single merged timeline
3. Permission UX → prototype's full pattern
4. Event rendering → full mapping with `raw` fallback
5. Architecture → shared `screens/` layer
6. Timeline rendering → SessionExecutionTimeline / SessionTimelineItem style; orphan EventTimeline path is dead code
7. Pairing UI → placeholder with `Run cc-remote pair` hint
8. e2e-real → Playwright; `artifacts/` gitignored; `screenshots/` tracked
