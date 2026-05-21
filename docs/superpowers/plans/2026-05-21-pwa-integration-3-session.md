# PWA Integration P3 — Session Live Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `RealApp.tsx`'s inline-styled `<SessionPane>` with a prototype-styled `<SessionView>` that renders a single merged timeline (chat + JSONL events + permission states) using the cards extracted in P2. Introduce the pure `mergeTimeline` derivation in `lib/timeline.ts`, the `useSessionTimeline` hook, the `renderTimelineItem` dispatcher, and the `SessionTimeline` rail wrapper. After P3 the live `/` route shows the new session UI; the home / header / settings paths remain inline-styled (they migrate in P4 + P5).

**Architecture:** Data flow stays identical at the protocol layer. `useHub` (still in `ws.ts`) remains the single WebSocket source of truth. A new derived hook `useSessionTimeline` reads `useHub`'s state for one selected session and runs `mergeTimeline` to produce a `TimelineEvent[]`. The `screens/SessionView` layer is **pure presentational** — it accepts props and emits callbacks, no WS imports. `renderTimelineItem.tsx` is a function (not a hook, not a component with internal state) that maps a `TimelineEvent` to JSX wrapped in a `SessionTimelineItem` (extracted in P2). v1 coverage of `mergeTimeline` is intentionally narrow: chat broadcasts → user/assistant, permissions → permission-inline/resolved, every JSONL event → `raw`. Tool / text-delta / thinking parsing is a follow-up; the cards are already extracted in P2 so the data-side upgrade is a one-file change to `mergeTimeline`.

**Tech Stack:** React 18, TypeScript strict, Tailwind 4, lucide-react, shadcn `Button`. No new dependencies.

**Reference:** Source spec — `docs/superpowers/specs/2026-05-21-pwa-prototype-integration-design.md` §1 invariants, §2.2 `mergeTimeline`, §2.3 hook surface, §2.4 SessionView prop shape, §3.2 connection state, §3.4 timeline edges, §4 milestone M4.

**Prerequisite:** P1 + P2 complete. `screens/primitives/` and `screens/timeline/cards/*` populated. `screens/timeline/SessionTimelineItem.tsx` and `screens/timeline/types.ts` exist. `RealApp.tsx` still uses `SessionPane.tsx`.

---

## File structure after P3

```
packages/pwa/src/
├── hooks/
│   └── useSessionTimeline.ts          # NEW
├── lib/
│   └── timeline.ts                    # NEW (pure mergeTimeline + helpers)
├── screens/
│   ├── SessionView.tsx                # NEW
│   └── timeline/
│       ├── SessionTimeline.tsx        # NEW (rail + scroll + load-earlier)
│       ├── SessionTimelineItem.tsx    # exists (P2)
│       ├── renderTimelineItem.tsx     # NEW
│       ├── types.ts                   # exists (P2)
│       └── cards/                     # exists (P2)
├── RealApp.tsx                        # MODIFIED — uses SessionView via useSessionTimeline
└── SessionPane.tsx                    # unchanged in P3 (deleted in P5/M9)
```

`SessionPane.tsx` remains on disk in P3 — it's only imported once (by `RealApp.tsx`), and once that import flips to `SessionView` it becomes orphan code that the M9 cleanup task removes. Keeping the file in P3 means a single-line revert is enough if the new path misbehaves.

The `screens/timeline/types.ts` `TimelineEvent` union introduced in P2 is the canonical shape across mergeTimeline → useSessionTimeline → renderTimelineItem.

---

## Task 1: Pure derivation — `lib/timeline.ts mergeTimeline`

**Why:** A pure function in `lib/` is unit-testable without React. Writing it first nails down the data contract before any UI code consumes it. v1 scope is deliberately narrow (chat + permission frames + raw fallback for JSONL); follow-ups extend the parser without touching the call site.

**Files:**
- Create: `packages/pwa/src/lib/timeline.ts`
- Create: `packages/pwa/tests/timeline.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/pwa/tests/timeline.test.ts`:

```ts
import { expect, test } from "bun:test";
import type {
  EventFrameForPwa,
  PwaChatBroadcast,
  PwaPermissionRequest,
  PwaPermissionResolved,
} from "@cc-remote/proto";
import { mergeTimeline } from "../src/lib/timeline";

const D = "daemon-1";
const S = "session-1";

function chat(
  message_id: string,
  from: "pwa" | "claude",
  content: string,
  ts: number,
): PwaChatBroadcast {
  return {
    type: "chat",
    daemon_id: D,
    session_id: S,
    message_id,
    from,
    user: from === "pwa" ? "alice@example.com" : null,
    content,
    reply_to: null,
    ts,
  };
}

function event(
  jsonl_offset: number,
  ts: number,
  payload: unknown,
): EventFrameForPwa {
  return {
    type: "event",
    daemon_id: D,
    session_id: S,
    jsonl_offset,
    ts,
    payload,
  };
}

function pending(request_id: string, expires_at: number): PwaPermissionRequest {
  return {
    type: "permission_request",
    daemon_id: D,
    session_id: S,
    request_id,
    tool: "Bash",
    args_summary: "rm -rf /tmp/foo",
    expires_at,
  };
}

function resolved(
  request_id: string,
  decision: PwaPermissionResolved["decision"],
): PwaPermissionResolved {
  return {
    type: "permission_resolved",
    daemon_id: D,
    session_id: S,
    request_id,
    decision,
    decided_via: "pwa",
  };
}

test("empty inputs produce empty timeline", () => {
  expect(mergeTimeline({ events: [], chat: [], pending: [], resolved: [] })).toEqual([]);
});

test("chat broadcasts emit user and assistant items in order", () => {
  const items = mergeTimeline({
    events: [],
    chat: [
      chat("m1", "pwa", "hello", 1_700_000_000),
      chat("m2", "claude", "hi", 1_700_000_001),
    ],
    pending: [],
    resolved: [],
  });
  expect(items).toHaveLength(2);
  expect(items[0]).toMatchObject({ kind: "user", body: "hello" });
  expect(items[1]).toMatchObject({ kind: "assistant", body: "hi" });
});

test("each EventFrame falls through to raw with payload type as title", () => {
  const items = mergeTimeline({
    events: [
      event(10, 1_700_000_000_000, { type: "session_start", model: "sonnet" }),
      event(20, 1_700_000_001_000, { type: "user", message: { content: "hi" } }),
      event(30, 1_700_000_002_000, { whatever: true }),
    ],
    chat: [],
    pending: [],
    resolved: [],
  });
  expect(items).toHaveLength(3);
  expect(items[0]).toMatchObject({ kind: "raw", title: "session_start" });
  expect(items[1]).toMatchObject({ kind: "raw", title: "user" });
  expect(items[2]).toMatchObject({ kind: "raw", title: "event" });
  // The json field round-trips via JSON.parse for safety.
  for (const item of items) {
    if (item.kind === "raw") {
      expect(() => JSON.parse(item.json)).not.toThrow();
    }
  }
});

test("pending permissions emit permission-inline items", () => {
  const items = mergeTimeline({
    events: [],
    chat: [],
    pending: [pending("req-1", 1_700_000_010)],
    resolved: [],
  });
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    kind: "permission-inline",
    tool: "Bash",
    command: "rm -rf /tmp/foo",
  });
});

test("resolved permissions emit permission-resolved items mapped per decision", () => {
  const items = mergeTimeline({
    events: [],
    chat: [],
    pending: [],
    resolved: [
      resolved("req-1", "allow"),
      resolved("req-2", "deny"),
      resolved("req-3", "expired"),
      resolved("req-4", "terminal"),
    ],
  });
  expect(items.map((i) => i.kind === "permission-resolved" && i.decision)).toEqual([
    "allowed",
    "denied",
    "expired",
    "expired",
  ]);
});

test("items are sorted by timestamp; chat (seconds) and events (ms) interleave correctly", () => {
  const items = mergeTimeline({
    events: [
      event(10, 1_700_000_001_000, { type: "session_start" }), // ms
      event(20, 1_700_000_003_000, { type: "tool_use" }),       // ms
    ],
    chat: [
      chat("m1", "pwa", "first", 1_700_000_000),                // s → 1_700_000_000_000 ms
      chat("m2", "claude", "second", 1_700_000_002),            // s → 1_700_000_002_000 ms
    ],
    pending: [],
    resolved: [],
  });
  expect(items.map((i) => i.id)).toEqual([
    "chat:m1",
    "event:10",
    "chat:m2",
    "event:20",
  ]);
});

test("ids are stable and deterministic — same input twice produces same ids", () => {
  const args = {
    events: [event(10, 1_700_000_001_000, { type: "x" })],
    chat: [chat("m1", "pwa", "hi", 1_700_000_000)],
    pending: [pending("req-1", 1_700_000_010)],
    resolved: [resolved("req-2", "allow")],
  };
  const a = mergeTimeline(args);
  const b = mergeTimeline(args);
  expect(a.map((i) => i.id)).toEqual(b.map((i) => i.id));
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd packages/pwa && bun test tests/timeline.test.ts
```

Expected: FAIL — `mergeTimeline` undefined / module not found.

- [ ] **Step 3: Implement `lib/timeline.ts`**

Create `packages/pwa/src/lib/timeline.ts`:

```ts
import type {
  EventFrameForPwa,
  PwaChatBroadcast,
  PwaPermissionRequest,
  PwaPermissionResolved,
} from "@cc-remote/proto";
import type { TimelineEvent } from "../screens/timeline/types";

export interface MergeTimelineArgs {
  events: EventFrameForPwa[];
  chat: PwaChatBroadcast[];
  pending: PwaPermissionRequest[];
  resolved: PwaPermissionResolved[];
}

interface TimedItem {
  /** Unix milliseconds — the sole ordering key for the merged timeline. */
  tsMs: number;
  /** Tiebreaker for stable ordering when timestamps collide (e.g. chat and event in the same ms). */
  rank: number;
  item: TimelineEvent;
}

/**
 * Pure derivation of the visible timeline from the four hub-state slices for one session.
 * Output is sorted by timestamp; ids are deterministic.
 */
export function mergeTimeline(args: MergeTimelineArgs): TimelineEvent[] {
  const buf: TimedItem[] = [];

  // Chat broadcasts → user / assistant. Chat ts is unix seconds (per @cc-remote/proto).
  for (const m of args.chat) {
    const tsMs = m.ts * 1000;
    buf.push({
      tsMs,
      rank: 0,
      item: {
        id: `chat:${m.message_id}`,
        kind: m.from === "pwa" ? "user" : "assistant",
        title: m.from === "pwa" ? (m.user ?? "You") : "Claude",
        body: m.content,
        time: formatClockTime(tsMs),
      },
    });
  }

  // EventFrameForPwa → raw fallback (v1).
  // ts is unix milliseconds when populated by the daemon. History-replayed events
  // arrive with ts === 0; fall back to jsonl_offset for stable ordering.
  for (const e of args.events) {
    const tsMs = e.ts > 0 ? e.ts : 0;
    const payloadType = extractPayloadType(e.payload);
    buf.push({
      tsMs,
      rank: e.jsonl_offset,
      item: {
        id: `event:${e.jsonl_offset}`,
        kind: "raw",
        title: payloadType,
        json: safeStringify(e.payload),
      },
    });
  }

  // Pending permission requests → permission-inline.
  // expires_at is unix seconds (per @cc-remote/proto).
  for (const p of args.pending) {
    const tsMs = p.expires_at * 1000;
    buf.push({
      tsMs,
      rank: 0,
      item: {
        id: `perm:${p.request_id}`,
        kind: "permission-inline",
        tool: p.tool,
        command: p.args_summary,
        risk: "warning",
      },
    });
  }

  // Resolved permissions → permission-resolved. The protocol carries no ts
  // on the resolved frame, so we sort them after pending requests via a high
  // rank — the live UI will mostly receive these one at a time anyway.
  for (const r of args.resolved) {
    buf.push({
      tsMs: 0,
      rank: Number.MAX_SAFE_INTEGER,
      item: {
        id: `perm-res:${r.request_id}`,
        kind: "permission-resolved",
        decision: mapDecision(r.decision),
        via: r.decided_via,
        time: "",
      },
    });
  }

  buf.sort((a, b) => (a.tsMs - b.tsMs) || (a.rank - b.rank));
  return buf.map((b) => b.item);
}

function extractPayloadType(payload: unknown): string {
  if (
    payload !== null &&
    typeof payload === "object" &&
    "type" in payload &&
    typeof (payload as { type: unknown }).type === "string"
  ) {
    return (payload as { type: string }).type;
  }
  return "event";
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "{}";
  }
}

function mapDecision(
  d: PwaPermissionResolved["decision"],
): "allowed" | "denied" | "expired" {
  if (d === "allow") return "allowed";
  if (d === "deny") return "denied";
  return "expired";
}

function formatClockTime(tsMs: number): string {
  if (tsMs <= 0) return "";
  const date = new Date(tsMs);
  const h = date.getHours();
  const m = date.getMinutes().toString().padStart(2, "0");
  const period = h >= 12 ? "PM" : "AM";
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:${m} ${period}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd packages/pwa && bun test tests/timeline.test.ts
```

Expected: 7 pass, 0 fail.

- [ ] **Step 5: Workspace typecheck**

```bash
bun run typecheck
```

Expected: zero errors. (`@cc-remote/proto` is already a workspace dep; the import path resolves through the existing tsconfig project refs.)

- [ ] **Step 6: Commit**

```bash
git add packages/pwa/src/lib/timeline.ts packages/pwa/tests/timeline.test.ts
git commit -m "feat(pwa): mergeTimeline pure derivation in lib/timeline.ts"
```

---

## Task 2: Per-event renderer — `screens/timeline/renderTimelineItem.tsx`

**Why:** Maps each `TimelineEvent` (v1 kinds: user / assistant / permission-inline / permission-resolved / raw — plus all the cards already extracted in P2 for forward-compat) into a `SessionTimelineItem` with the right marker and the right card body. Pure function returning JSX — no internal state.

**Files:**
- Create: `packages/pwa/src/screens/timeline/renderTimelineItem.tsx`

- [ ] **Step 1: Implement the dispatcher**

Create `packages/pwa/src/screens/timeline/renderTimelineItem.tsx`:

```tsx
import { ChevronRight, Code2, ShieldAlert, ShieldCheck, Terminal } from "lucide-react";
import type React from "react";
import { Button } from "../../components/ui/button";
import { CatalogCard } from "./cards/CatalogCard";
import { CatalogHeader } from "./cards/CatalogHeader";
import { UserBubbleSurface } from "./cards/UserBubble";
import { SessionTimelineItem, type TimelineMarker } from "./SessionTimelineItem";
import type { TimelineEvent } from "./types";

export interface RenderTimelineItemContext {
  /** Called when the user taps "Review" on an inline permission card. */
  onOpenPermission?: (request_id: string) => void;
}

/**
 * Pure mapping from a `TimelineEvent` to a `SessionTimelineItem` wrapping the right card body.
 * Per spec §1 invariant 2:
 *   user                                          → marker: user
 *   assistant, thinking                           → marker: claude
 *   tool, permission-inline, subagent, batch,
 *     task(status=created)                        → marker: tool
 *   permission-resolved, task(status=completed)   → marker: success
 *   system, compact, session-boundary, metadata,
 *     error, raw                                  → marker: idle
 */
export function renderTimelineItem(
  event: TimelineEvent,
  ctx: RenderTimelineItemContext = {},
): React.ReactElement {
  const marker = pickMarker(event);

  switch (event.kind) {
    case "user":
      return (
        <SessionTimelineItem key={event.id} marker={marker} meta={event.time} title={event.title}>
          <CatalogCard>
            <UserBubbleBodyLive body={event.body} time={event.time} />
          </CatalogCard>
        </SessionTimelineItem>
      );

    case "assistant":
      return (
        <SessionTimelineItem key={event.id} marker={marker}>
          <CatalogCard>
            <CatalogHeader icon={Terminal} title={event.title} meta={event.time} />
            <p className="mt-2 leading-5 whitespace-pre-wrap">{event.body}</p>
          </CatalogCard>
        </SessionTimelineItem>
      );

    case "permission-inline":
      return (
        <SessionTimelineItem key={event.id} marker={marker}>
          <CatalogCard tone="warning">
            <CatalogHeader icon={ShieldAlert} title="Permission required" tone="warning" />
            <div className="mt-3 grid gap-1 text-xs">
              <p>
                Tool <span className="ml-6 font-mono">{event.tool}</span>
              </p>
              <p>
                Command <span className="font-mono">{event.command}</span>
              </p>
            </div>
            <Button
              className="mt-3 w-full"
              size="sm"
              variant="secondary"
              onClick={() => ctx.onOpenPermission?.(stripPermPrefix(event.id))}
            >
              Review
            </Button>
          </CatalogCard>
        </SessionTimelineItem>
      );

    case "permission-resolved":
      return (
        <SessionTimelineItem key={event.id} marker={marker}>
          <CatalogCard tone={event.decision === "allowed" ? "success" : "danger"}>
            <CatalogHeader
              icon={ShieldCheck}
              title={
                event.decision === "allowed"
                  ? "Permission granted"
                  : event.decision === "denied"
                    ? "Permission denied"
                    : "Permission expired"
              }
              tone={event.decision === "allowed" ? "success" : "danger"}
            />
            <p className="text-muted-foreground mt-2 text-xs">via {event.via}</p>
          </CatalogCard>
        </SessionTimelineItem>
      );

    case "raw":
      return (
        <SessionTimelineItem key={event.id} marker={marker}>
          <CatalogCard>
            <CatalogHeader icon={Code2} title={event.title} />
            <pre className="bg-muted mt-3 max-h-40 overflow-auto rounded-md p-2 font-mono text-xs leading-5">
              {event.json}
            </pre>
            <div className="mt-3 flex items-center justify-between">
              <span className="text-primary text-xs font-semibold">Raw payload</span>
              <ChevronRight className="text-muted-foreground size-4" />
            </div>
          </CatalogCard>
        </SessionTimelineItem>
      );

    default:
      // Future kinds (thinking / tool / subagent / batch / task / system / error)
      // are produced by mergeTimeline upgrades. Render a minimal raw shell so an
      // unhandled kind never crashes the timeline.
      return (
        <SessionTimelineItem key={event.id} marker={marker}>
          <CatalogCard>
            <CatalogHeader icon={Code2} title={event.kind} />
          </CatalogCard>
        </SessionTimelineItem>
      );
  }
}

function pickMarker(event: TimelineEvent): TimelineMarker {
  switch (event.kind) {
    case "user":
      return "user";
    case "assistant":
    case "thinking":
      return "claude";
    case "tool":
    case "permission-inline":
    case "subagent":
    case "batch":
      return "tool";
    case "task":
      return event.status === "completed" ? "success" : "tool";
    case "permission-resolved":
      return "success";
    case "system":
    case "compact":
    case "session-boundary":
    case "metadata":
    case "error":
    case "raw":
      return "idle";
  }
}

function UserBubbleBodyLive({ body, time }: { body: string; time: string }) {
  return (
    <div className="bg-primary-subtle border-primary/20 ml-auto max-w-[92%] rounded-md border p-3">
      <p className="whitespace-pre-wrap">{body}</p>
      {time && (
        <p className="text-muted-foreground mt-2 text-right text-xs">{time}</p>
      )}
    </div>
  );
}

function stripPermPrefix(id: string): string {
  return id.startsWith("perm:") ? id.slice("perm:".length) : id;
}

// Keep `UserBubbleSurface` re-export shape stable for tooling/imports.
export { UserBubbleSurface };
```

- [ ] **Step 2: Verify typecheck**

```bash
cd packages/pwa && bun run typecheck
```

Expected: zero errors. (Imports must resolve to the modules created in P1/P2.)

- [ ] **Step 3: Commit**

```bash
git add packages/pwa/src/screens/timeline/renderTimelineItem.tsx
git commit -m "feat(pwa): renderTimelineItem dispatcher (TimelineEvent → SessionTimelineItem + card)"
```

---

## Task 3: Rail wrapper — `screens/timeline/SessionTimeline.tsx`

**Why:** The rail container that holds all `SessionTimelineItem`s, owns the scroll element, and triggers `onLoadEarlier()` near the top. Same scroll heuristics as the existing `SessionPane.tsx` (within 80px of top, throttled 500 ms) plus an explicit `Load earlier events` button per spec §3.4.

**Files:**
- Create: `packages/pwa/src/screens/timeline/SessionTimeline.tsx`

- [ ] **Step 1: Implement the wrapper**

Create `packages/pwa/src/screens/timeline/SessionTimeline.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { renderTimelineItem, type RenderTimelineItemContext } from "./renderTimelineItem";
import type { TimelineEvent } from "./types";

export interface SessionTimelineProps {
  items: TimelineEvent[];
  onLoadEarlier: () => void;
  onOpenPermission?: (request_id: string) => void;
}

export function SessionTimeline({ items, onLoadEarlier, onOpenPermission }: SessionTimelineProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const lastLoadAt = useRef(0);

  useEffect(() => {
    if (!autoScroll || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [items, autoScroll]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    setAutoScroll(atBottom);
    const now = Date.now();
    if (el.scrollTop < 80 && items.length > 0 && now - lastLoadAt.current > 500) {
      lastLoadAt.current = now;
      onLoadEarlier();
    }
  };

  const ctx: RenderTimelineItemContext = { onOpenPermission };

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      data-testid="timeline"
      className="bg-background flex-1 overflow-y-auto"
    >
      {items.length === 0 ? (
        <div className="flex h-full items-center justify-center p-6">
          <p className="text-muted-foreground text-sm">Send a message to start.</p>
        </div>
      ) : (
        <div className="relative px-4 py-4 pl-12">
          <div className="bg-border absolute top-2 bottom-2 left-7 w-px" />
          <div className="mb-3 flex justify-center">
            <Button onClick={onLoadEarlier} size="sm" variant="ghost">
              Load earlier events
            </Button>
          </div>
          {items.map((it) => renderTimelineItem(it, ctx))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify typecheck**

```bash
cd packages/pwa && bun run typecheck
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add packages/pwa/src/screens/timeline/SessionTimeline.tsx
git commit -m "feat(pwa): SessionTimeline rail wrapper (scroll + load-earlier)"
```

---

## Task 4: Derived hook — `hooks/useSessionTimeline.ts`

**Why:** Bridges `useHub` (single source of truth for hub state) and `mergeTimeline` (pure derivation). Returns the four things `SessionView` needs: items, loadEarlier, composerBlocked, online. Keeping the bridge here means `screens/SessionView.tsx` stays free of hub imports (per spec invariant: `screens/` is presentational only).

**Files:**
- Create: `packages/pwa/src/hooks/useSessionTimeline.ts`

- [ ] **Step 1: Implement the hook**

Create `packages/pwa/src/hooks/useSessionTimeline.ts`:

```ts
import { useMemo } from "react";
import type { PwaPermissionRequest, PwaPermissionResolved } from "@cc-remote/proto";
import { mergeTimeline } from "../lib/timeline";
import type { TimelineEvent } from "../screens/timeline/types";
import { eventKey, type UseHubResult } from "../ws";

export interface UseSessionTimelineResult {
  items: TimelineEvent[];
  loadEarlier: () => void;
  composerBlocked: boolean;
  online: boolean;
  pendingInThisSession?: PwaPermissionRequest;
}

export interface SelectedSession {
  daemon_id: string;
  session_id: string;
}

/**
 * Derives the merged timeline + composer/online flags for one selected session.
 *
 * `resolved` is intentionally always empty in v1: the hub only broadcasts
 * permission_resolved frames live (no persistence), and `useHub` removes the
 * matching pending entry on resolve. So once a permission is resolved there
 * is no live source for the resolved card. This hook accepts the gap and
 * does not synthesize history. (Spec §2.5 — daemon-side persistence is the
 * future fix.)
 */
export function useSessionTimeline(
  hub: UseHubResult,
  selected: SelectedSession | null,
): UseSessionTimelineResult {
  return useMemo(() => {
    if (!selected) {
      return {
        items: [],
        loadEarlier: () => {},
        composerBlocked: false,
        online: false,
      };
    }
    const k = eventKey(selected.daemon_id, selected.session_id);
    const events = hub.events[k] ?? [];
    const chat = hub.chatMessages[k] ?? [];
    const pending = Object.values(hub.pendingPermissions).filter(
      (p) => p.daemon_id === selected.daemon_id && p.session_id === selected.session_id,
    );
    const resolved: PwaPermissionResolved[] = [];

    const items = mergeTimeline({ events, chat, pending, resolved });

    const daemon = hub.daemons.find((d) => d.daemon_id === selected.daemon_id);
    const online =
      !!daemon?.online &&
      !!daemon.sessions.some((s) => s.session_id === selected.session_id);

    const oldestOffset = events[0]?.jsonl_offset;
    const loadEarlier =
      oldestOffset === undefined
        ? () => {}
        : () => hub.requestHistory(selected.daemon_id, selected.session_id, oldestOffset, 50);

    return {
      items,
      loadEarlier,
      composerBlocked: pending.length > 0,
      online,
      pendingInThisSession: pending[0],
    };
  }, [hub, selected]);
}
```

- [ ] **Step 2: Verify typecheck**

```bash
cd packages/pwa && bun run typecheck
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add packages/pwa/src/hooks/useSessionTimeline.ts
git commit -m "feat(pwa): useSessionTimeline derived hook"
```

---

## Task 5: Presentational shell — `screens/SessionView.tsx`

**Why:** The single component that replaces `SessionPane.tsx`. Header (name / model / cwd / online chip) + `<SessionTimeline>` + Composer. Pure props, no hub imports. Composer testid (`chat-input`) and timeline testid (`timeline`) match the spec §4.1 stable-selector list so the e2e-real Playwright pass added in §4.5 finds them.

**Files:**
- Create: `packages/pwa/src/screens/SessionView.tsx`

- [ ] **Step 1: Implement the screen**

Create `packages/pwa/src/screens/SessionView.tsx`:

```tsx
import { useState } from "react";
import { ArrowLeft, Send, X } from "lucide-react";
import type { PwaPermissionRequest } from "@cc-remote/proto";
import { Button } from "../components/ui/button";
import { StatusChip } from "./primitives/StatusChip";
import { SessionTimeline } from "./timeline/SessionTimeline";
import type { TimelineEvent } from "./timeline/types";

export interface SessionViewProps {
  header: { name: string; model: string | null; cwd: string; online: boolean };
  items: TimelineEvent[];
  composerBlocked: boolean;
  pendingPermissionInThisSession?: PwaPermissionRequest;
  chatError?: string;
  onLoadEarlier: () => void;
  onSendChat: (content: string) => void;
  onOpenPermission: (request_id: string) => void;
  onBack: () => void;
}

export function SessionView({
  header,
  items,
  composerBlocked,
  pendingPermissionInThisSession,
  chatError,
  onLoadEarlier,
  onSendChat,
  onOpenPermission,
  onBack,
}: SessionViewProps) {
  const [draft, setDraft] = useState("");

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    const t = draft.trim();
    if (!t) return;
    onSendChat(t);
    setDraft("");
  };

  return (
    <aside
      className="border-border bg-surface fixed inset-y-0 right-0 z-40 flex w-[min(720px,90vw)] flex-col border-l shadow-xl"
      data-testid="session-view"
    >
      <header className="border-border flex items-center justify-between gap-2 border-b p-3">
        <div className="flex min-w-0 items-center gap-2">
          <Button aria-label="Back" onClick={onBack} size="icon" variant="ghost">
            <ArrowLeft className="size-4" />
          </Button>
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold">{header.name}</h2>
            <p className="text-muted-foreground truncate font-mono text-xs">
              {header.cwd}
              {header.model ? ` · ${header.model}` : ""}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <StatusChip
            label={header.online ? "Online" : "Offline"}
            tone={header.online ? "online" : "offline"}
          />
          <Button aria-label="Close" onClick={onBack} size="icon" variant="ghost">
            <X className="size-4" />
          </Button>
        </div>
      </header>

      <div className="flex flex-1 flex-col overflow-hidden" data-testid="chat-log">
        <SessionTimeline
          items={items}
          onLoadEarlier={onLoadEarlier}
          onOpenPermission={onOpenPermission}
        />
      </div>

      <div className="border-border bg-surface border-t p-3 pb-[calc(12px+env(safe-area-inset-bottom))]">
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
        {chatError && (
          <div className="bg-danger-subtle text-danger mb-2 rounded-md px-3 py-2 text-xs">
            chat error: {chatError}
          </div>
        )}
        <form className="flex gap-2" onSubmit={handleSend}>
          <input
            className="border-border bg-muted focus:border-ring focus:ring-ring/30 disabled:text-disabled h-11 min-w-0 flex-1 rounded-md border px-3 text-base outline-none focus:ring-2"
            data-testid="chat-input"
            disabled={composerBlocked || !header.online}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={
              composerBlocked
                ? "Waiting for permission"
                : header.online
                  ? "Message Claude…"
                  : "session offline"
            }
            value={draft}
          />
          <Button
            disabled={composerBlocked || !header.online || !draft.trim()}
            size="icon"
            type="submit"
          >
            <Send className="size-4" />
          </Button>
        </form>
      </div>
    </aside>
  );
}
```

- [ ] **Step 2: Verify typecheck**

```bash
cd packages/pwa && bun run typecheck
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add packages/pwa/src/screens/SessionView.tsx
git commit -m "feat(pwa): SessionView presentational shell"
```

---

## Task 6: Static-markup smoke test for SessionView

**Why:** Same protection as the per-card tests in P2 — a thin assertion that SessionView mounts with realistic props and surfaces stable testids. Catches regressions in marker mapping or composer wiring without booting a browser.

**Files:**
- Create: `packages/pwa/tests/SessionView.test.tsx`

- [ ] **Step 1: Write the test**

Create `packages/pwa/tests/SessionView.test.tsx`:

```tsx
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionView } from "../src/screens/SessionView";
import type { TimelineEvent } from "../src/screens/timeline/types";

const items: TimelineEvent[] = [
  {
    id: "chat:m1",
    kind: "user",
    title: "alice@example.com",
    body: "hello claude",
    time: "10:24 AM",
  },
  {
    id: "chat:m2",
    kind: "assistant",
    title: "Claude",
    body: "hello back",
    time: "10:24 AM",
  },
  {
    id: "event:1",
    kind: "raw",
    title: "session_start",
    json: '{"type":"session_start"}',
  },
];

test("SessionView renders header, timeline items, and composer", () => {
  const markup = renderToStaticMarkup(
    <SessionView
      header={{ name: "session-1", model: "sonnet", cwd: "/home/alice/proj", online: true }}
      items={items}
      composerBlocked={false}
      onLoadEarlier={() => {}}
      onSendChat={() => {}}
      onOpenPermission={() => {}}
      onBack={() => {}}
    />,
  );

  expect(markup).toContain("session-1");
  expect(markup).toContain("/home/alice/proj");
  expect(markup).toContain("Online");
  expect(markup).toContain("hello claude");
  expect(markup).toContain("hello back");
  expect(markup).toContain("session_start");
  expect(markup).toContain('data-testid="chat-input"');
  expect(markup).toContain('data-testid="timeline"');
  expect(markup).toContain("Message Claude");
});

test("SessionView shows the permission warning strip when blocked", () => {
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
      onLoadEarlier={() => {}}
      onSendChat={() => {}}
      onOpenPermission={() => {}}
      onBack={() => {}}
    />,
  );

  expect(markup).toContain("Permission required before Claude can continue.");
  expect(markup).toContain("Review");
  expect(markup).toContain("Waiting for permission");
});

test("SessionView reports offline state in header and disables composer placeholder", () => {
  const markup = renderToStaticMarkup(
    <SessionView
      header={{ name: "session-1", model: null, cwd: "/x", online: false }}
      items={[]}
      composerBlocked={false}
      onLoadEarlier={() => {}}
      onSendChat={() => {}}
      onOpenPermission={() => {}}
      onBack={() => {}}
    />,
  );

  expect(markup).toContain("Offline");
  expect(markup).toContain("session offline");
});
```

- [ ] **Step 2: Run the test**

```bash
cd packages/pwa && bun test tests/SessionView.test.tsx
```

Expected: 3 pass, 0 fail.

- [ ] **Step 3: Commit**

```bash
git add packages/pwa/tests/SessionView.test.tsx
git commit -m "test(pwa): static-markup smoke tests for SessionView"
```

---

## Task 7: Wire `RealApp.tsx` to `SessionView` via `useSessionTimeline`

**Why:** This is the only behavioral change in P3 — flip the live `/` route's session pane from inline-styled to prototype-styled. The header / daemon list stay inline-styled (P4 covers them). HomePane keeps its `data-testid="conn-status"` and `sessions-${daemon_id}` selectors unchanged.

**Files:**
- Modify: `packages/pwa/src/RealApp.tsx`

- [ ] **Step 1: Replace the SessionPane usage**

Edit `packages/pwa/src/RealApp.tsx`. The header / daemon-list block stays exactly as-is. Two changes:

1. Imports — drop `SessionPane`, add `SessionView` and `useSessionTimeline`:

```diff
-import { SessionPane } from "./SessionPane.tsx";
+import { SessionView } from "./screens/SessionView";
+import { useSessionTimeline } from "./hooks/useSessionTimeline";
```

2. Inside the `RealApp()` body, after the `useHub(...)` destructure and before the `if (!bearer)` early return, add the derived hook call:

```ts
const hub = useHub(HUB_URL, bearer);
const { connected, daemons, events, pendingPermissions, sendPermissionReply, completedCounts, idleSessions, chatErrors } = hub;
const sessionTimeline = useSessionTimeline(hub, selected);
```

(The original line `const { connected, daemons, events, pendingPermissions, sendPermissionReply, requestHistory, killSession, startSession, completedCounts, idleSessions, chatMessages, chatErrors, sendChat } = useHub(HUB_URL, bearer);` becomes the two lines above. The `chatMessages` / `requestHistory` / `sendChat` / `killSession` / `startSession` symbols are now referenced via `hub.*` — update the daemon-list section's `startSession` and `killSession` calls to `hub.startSession` and `hub.killSession`.)

3. Drop the now-unused `selectedEvents` / `selectedChat` variables (they were inputs to `SessionPane`):

```diff
-  const selectedEvents = selected ? (events[eventKey(selected.daemon_id, selected.session_id)] ?? []) : [];
-  const selectedChat = selected ? (chatMessages[eventKey(selected.daemon_id, selected.session_id)] ?? []) : [];
   const selectedChatError = selected ? chatErrors[eventKey(selected.daemon_id, selected.session_id)] : undefined;
   const selectedDaemon = selected ? daemons.find((d) => d.daemon_id === selected.daemon_id) : undefined;
-  const selectedSessionOnline = !!selectedDaemon?.online
-    && !!selectedDaemon?.sessions.some((s) => s.session_id === selected?.session_id);
+  const selectedSession = selected
+    ? selectedDaemon?.sessions.find((s) => s.session_id === selected.session_id)
+    : undefined;
```

4. Replace the `<SessionPane …/>` block at the bottom with `<SessionView …/>`:

```diff
-      {selected && (
-        <SessionPane
-          daemon_id={selected.daemon_id}
-          session_id={selected.session_id}
-          events={selectedEvents}
-          chatMessages={selectedChat}
-          chatError={selectedChatError}
-          sessionOnline={selectedSessionOnline}
-          onClose={() => setSelected(null)}
-          onLoadHistory={(before_offset) => requestHistory(selected.daemon_id, selected.session_id, before_offset, 50)}
-          onSendChat={(content) => sendChat(selected.daemon_id, selected.session_id, content)}
-        />
-      )}
+      {selected && (
+        <SessionView
+          header={{
+            name: selectedSession?.session_id ?? selected.session_id,
+            model: selectedSession?.model ?? null,
+            cwd: selectedSession?.cwd ?? "",
+            online: sessionTimeline.online,
+          }}
+          items={sessionTimeline.items}
+          composerBlocked={sessionTimeline.composerBlocked}
+          pendingPermissionInThisSession={sessionTimeline.pendingInThisSession}
+          chatError={selectedChatError}
+          onLoadEarlier={sessionTimeline.loadEarlier}
+          onSendChat={(content) => hub.sendChat(selected.daemon_id, selected.session_id, content)}
+          onOpenPermission={(request_id) => {
+            const req = pendingPermissions[request_id];
+            if (req) sendPermissionReply(req, "allow");
+          }}
+          onBack={() => setSelected(null)}
+        />
+      )}
```

Note on `onOpenPermission`: in P3 the dedicated `PermissionSurface` does not exist yet (P4 builds it). For the Review-button stop-gap we keep `<PermissionBanner>` rendering at the top of `RealApp` (already present in the file) — the user can still allow/deny from there. The `onOpenPermission` callback in `SessionView` therefore just routes to `sendPermissionReply(..., "allow")` as the simplest behavior-preserving fallback during P3. **P4 replaces this stub** with a real surface open.

- [ ] **Step 2: Verify typecheck**

```bash
bun run typecheck
```

Expected: zero errors. (`eventKey` is still imported and used by the daemon-list section's per-session counters — leave it untouched.)

- [ ] **Step 3: Run unit + e2e tests**

```bash
bun test packages/
bun test e2e/
```

Expected:
- `packages/`: prior baseline + 7 (timeline) + 3 (SessionView) = previous total + 10. All pass.
- `e2e/`: all 12 in-process scenarios still pass. (e2e is protocol-level — no DOM. The chat / permission frames flow through `useHub` unchanged, so behavior must be identical.)

- [ ] **Step 4: Manual smoke test in a real browser**

Start `cd packages/pwa && bun run dev` and visit `http://localhost:5173/`:

1. Sign in via the existing IAS button (whatever your local hub is set up for).
2. Wait for at least one daemon to register (the home view shows its hostname).
3. Click a session in the daemon list. Expected: the new prototype-styled `SessionView` slides in on the right edge.
4. Send a chat message with the Send button. Expected: the message appears in the timeline as a user bubble; Claude's reply appears as an assistant card.
5. Trigger a permission (run a tool that requires approval in the session). Expected: composer becomes disabled, warning strip appears above it, `<PermissionBanner>` (still inline-styled, top of viewport) lets you allow/deny.
6. Hit the back arrow / X — the `SessionView` closes.

Stop the dev server.

- [ ] **Step 5: Commit**

```bash
git add packages/pwa/src/RealApp.tsx
git commit -m "feat(pwa): RealApp uses SessionView via useSessionTimeline (M4)"
```

---

## Task 8: Final P3 verification

**Why:** Confirm the workspace is clean and every test layer agrees before handing off to P4.

- [ ] **Step 1: Workspace-wide typecheck**

```bash
bun run typecheck
```
Expected: every package green.

- [ ] **Step 2: Workspace-wide unit tests**

```bash
bun test packages/
```
Expected: all pass (P2 baseline + 10 new tests from this plan).

- [ ] **Step 3: In-process e2e**

```bash
bun test e2e/
```
Expected: all 12 in-process scenarios pass.

- [ ] **Step 4: Manual visual sanity on `/` and `/demo`**

Start `cd packages/pwa && bun run dev`:

- `/` — old inline header + daemon list, **new** SessionView when a session is selected. Chat / events / permission warning all render in the merged timeline.
- `/demo` — guided demo unchanged from P2; no regressions.

Stop the dev server.

- [ ] **Step 5: Confirm clean tree**

```bash
git status
```

Expected: working tree clean. P3 is done. Hand off to P4 (Home + Permission UX).
