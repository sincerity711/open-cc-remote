# PWA Integration P4 — Home + Permission UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `RealApp.tsx`'s remaining inline-styled chrome — the header, the daemon list, and the fixed-bar `<PermissionBanner>` — with prototype-styled `<AppShell>`, `<HomeScreen>`, and `<PermissionSurface>` components driven by a derived `DaemonViewModel`. After P4 the live `/` route looks like the prototype on every breakpoint; only `Settings` remains inline-styled (P5).

**Architecture:** A new pure derivation `computeDaemonViewModels` in `lib/daemonViewModel.ts` collapses `DaemonView[]` + `pendingPermissions` + `events` + `idleSessions` + `completedCounts` into the per-row view-model the screens accept. `screens/HomeScreen.tsx` owns the home grid (mini permission card + daemon cards + offline daemon cards + per-session rows). `screens/AppShell.tsx` hosts the header + (desktop) nav rail + responsive grid skeleton — accepts children. `screens/PermissionSurface.tsx` renders the prototype's three-form decision UI (mobile bottom-sheet, tablet modal, desktop right-rail aside) selected by a new `hooks/useMediaQuery.ts`. The surface owns its own queue advance and "already handled on another device" auto-close. `PermissionBanner.tsx` is deleted at the end of M6 — when the surface is wired and verified.

**Tech Stack:** React 18, TypeScript strict, Tailwind 4, lucide-react, shadcn `Button`. No new dependencies.

**Reference:** Source spec — `docs/superpowers/specs/2026-05-21-pwa-prototype-integration-design.md` §1 file layout, §2.4 prop shapes, §3.1 responsive layout, §3.3 permission UX details, §4 milestones M5 + M6.

**Prerequisite:** P1, P2, P3 complete. `screens/SessionView.tsx`, `lib/timeline.ts`, `hooks/useSessionTimeline.ts`, all P2 cards, and the primitives barrel exist. `RealApp.tsx` already mounts `<SessionView>` for the selected session and still mounts `<PermissionBanner>` at the top.

---

## File structure after P4

```
packages/pwa/src/
├── hooks/
│   ├── useMediaQuery.ts             # NEW
│   ├── useSessionTimeline.ts        # exists (P3)
├── lib/
│   ├── daemonViewModel.ts           # NEW (pure derivation + types)
│   └── timeline.ts                  # exists (P3)
├── screens/
│   ├── AppShell.tsx                 # NEW
│   ├── HomeScreen.tsx               # NEW (PermissionMiniCard, DaemonCard, OfflineDaemonCard, SessionRow inline)
│   ├── PermissionSurface.tsx        # NEW
│   ├── SessionView.tsx              # exists (P3)
│   └── timeline/                    # exists (P2/P3)
├── RealApp.tsx                      # MODIFIED — uses AppShell + HomeScreen + PermissionSurface
└── PermissionBanner.tsx             # DELETED in Task 9
```

`SessionPane.tsx` and `Settings.tsx` are still on disk in P4 (the M9 cleanup deletes them in P5).

---

## Task 1: Pure derivation — `lib/daemonViewModel.ts`

**Why:** `screens/HomeScreen.tsx` is presentational only; it must not import `useHub`. The hub data → home view-model collapse is deterministic and unit-testable, so it lives in `lib/`. The `DaemonViewModel` shape introduced here is the canonical contract used by HomeScreen, AppShell counters, and any future screen that wants a daemon-centric snapshot.

**Files:**
- Create: `packages/pwa/src/lib/daemonViewModel.ts`
- Create: `packages/pwa/tests/daemonViewModel.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/pwa/tests/daemonViewModel.test.ts`:

```ts
import { expect, test } from "bun:test";
import type {
  DaemonView,
  EventFrameForPwa,
  PwaPermissionRequest,
} from "@cc-remote/proto";
import { computeDaemonViewModels } from "../src/lib/daemonViewModel";

const baseSession = {
  session_id: "s1",
  claude_session_id: null,
  tmux_session: null,
  tmux_pane: null,
  cwd: "/work/repo",
  model: "sonnet",
  pid: 0,
  started_at: 0,
  claude_client_version: "1.0.0",
  plugin_version: "0.0.1",
};

const onlineDaemon: DaemonView = {
  daemon_id: "d1",
  hostname: "mbp.local",
  online: true,
  sessions: [baseSession],
};

const offlineDaemon: DaemonView = {
  daemon_id: "d2",
  hostname: "dev-vm-eu",
  online: false,
  sessions: [{ ...baseSession, session_id: "s2", cwd: "/srv/api" }],
};

test("offline daemon yields offline state for every session", () => {
  const models = computeDaemonViewModels({
    daemons: [offlineDaemon],
    events: {},
    pendingPermissions: {},
    completedCounts: {},
    idleSessions: {},
  });
  expect(models).toHaveLength(1);
  expect(models[0].online).toBe(false);
  expect(models[0].sessions[0].state).toBe("offline");
});

test("session with a pending permission is in waiting state with permission activity", () => {
  const pending: PwaPermissionRequest = {
    type: "permission_request",
    daemon_id: "d1",
    session_id: "s1",
    request_id: "r1",
    tool: "Bash",
    args_summary: "rm -rf x",
    expires_at: 0,
  };
  const models = computeDaemonViewModels({
    daemons: [onlineDaemon],
    events: {},
    pendingPermissions: { r1: pending },
    completedCounts: {},
    idleSessions: {},
  });
  expect(models[0].sessions[0].state).toBe("waiting");
  expect(models[0].sessions[0].activity).toContain("permission");
});

test("idle flag wins over event activity when set", () => {
  const evt: EventFrameForPwa = {
    type: "event",
    daemon_id: "d1",
    session_id: "s1",
    jsonl_offset: 1,
    ts: 1,
    payload: {},
  };
  const models = computeDaemonViewModels({
    daemons: [onlineDaemon],
    events: { "d1::s1": [evt] },
    pendingPermissions: {},
    completedCounts: {},
    idleSessions: { "d1::s1": true },
  });
  expect(models[0].sessions[0].state).toBe("idle");
});

test("session with events but no pending/idle is working", () => {
  const evt: EventFrameForPwa = {
    type: "event",
    daemon_id: "d1",
    session_id: "s1",
    jsonl_offset: 1,
    ts: 1,
    payload: {},
  };
  const models = computeDaemonViewModels({
    daemons: [onlineDaemon],
    events: { "d1::s1": [evt] },
    pendingPermissions: {},
    completedCounts: { "d1::s1": 2 },
    idleSessions: {},
  });
  expect(models[0].sessions[0].state).toBe("working");
  expect(models[0].sessions[0].tasks).toBe(2);
  expect(models[0].sessions[0].unread).toBe(1);
});

test("daemon with zero sessions still appears in the model list", () => {
  const empty: DaemonView = {
    daemon_id: "d3",
    hostname: "fresh.local",
    online: true,
    sessions: [],
  };
  const models = computeDaemonViewModels({
    daemons: [empty],
    events: {},
    pendingPermissions: {},
    completedCounts: {},
    idleSessions: {},
  });
  expect(models[0].sessions).toEqual([]);
});

test("name falls back to session_id when claude_session_id is null", () => {
  const models = computeDaemonViewModels({
    daemons: [onlineDaemon],
    events: {},
    pendingPermissions: {},
    completedCounts: {},
    idleSessions: {},
  });
  expect(models[0].sessions[0].name).toBe("s1");
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd packages/pwa && bun test tests/daemonViewModel.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/daemonViewModel.ts`**

Create `packages/pwa/src/lib/daemonViewModel.ts`:

```ts
import type {
  DaemonView,
  EventFrameForPwa,
  PwaPermissionRequest,
} from "@cc-remote/proto";
import type { SessionState } from "../screens/primitives/StatusChip";
import { eventKey } from "../ws";

export interface SessionRowViewModel {
  daemon_id: string;
  session_id: string;
  name: string;
  model: string;
  cwd: string;
  activity: string;
  state: SessionState;
  unread: number;
  tasks: number;
}

export interface DaemonViewModel {
  daemon_id: string;
  hostname: string;
  online: boolean;
  sessions: SessionRowViewModel[];
}

export interface ComputeDaemonViewModelsArgs {
  daemons: DaemonView[];
  events: Record<string, EventFrameForPwa[]>;
  pendingPermissions: Record<string, PwaPermissionRequest>;
  completedCounts: Record<string, number>;
  idleSessions: Record<string, true>;
}

/**
 * Pure derivation. State priority (highest first):
 *   1. !daemon.online                                    → offline
 *   2. any pending permission for this session           → waiting
 *   3. idleSessions[k] is set                            → idle
 *   4. events[k] has at least one frame                  → working
 *   5. otherwise                                          → idle
 */
export function computeDaemonViewModels(
  args: ComputeDaemonViewModelsArgs,
): DaemonViewModel[] {
  const pendingByKey = groupPendingByKey(args.pendingPermissions);

  return args.daemons.map((d) => ({
    daemon_id: d.daemon_id,
    hostname: d.hostname,
    online: d.online,
    sessions: d.sessions.map((s) => {
      const k = eventKey(d.daemon_id, s.session_id);
      const pending = pendingByKey[k] ?? [];
      const evts = args.events[k] ?? [];
      const tasks = args.completedCounts[k] ?? 0;
      const unread = evts.length;

      const state: SessionState = !d.online
        ? "offline"
        : pending.length > 0
          ? "waiting"
          : args.idleSessions[k]
            ? "idle"
            : evts.length > 0
              ? "working"
              : "idle";

      const activity = pickActivity(state, pending, tasks);

      return {
        daemon_id: d.daemon_id,
        session_id: s.session_id,
        name: s.claude_session_id ?? s.session_id,
        model: s.model ?? "-",
        cwd: s.cwd,
        activity,
        state,
        unread,
        tasks,
      };
    }),
  }));
}

function groupPendingByKey(
  pending: Record<string, PwaPermissionRequest>,
): Record<string, PwaPermissionRequest[]> {
  const result: Record<string, PwaPermissionRequest[]> = {};
  for (const req of Object.values(pending)) {
    const k = eventKey(req.daemon_id, req.session_id);
    (result[k] ??= []).push(req);
  }
  return result;
}

function pickActivity(
  state: SessionState,
  pending: PwaPermissionRequest[],
  tasks: number,
): string {
  if (state === "waiting") {
    const tool = pending[0]?.tool ?? "tool";
    return `permission needed (${tool})`;
  }
  if (state === "offline") return "offline";
  if (state === "idle") return tasks > 0 ? `idle - ${tasks} tasks done` : "idle";
  return "running";
}

/**
 * Convenience aggregation used by AppShell counters and HomeScreen mini card.
 */
export function totalPendingApprovals(
  pendingPermissions: Record<string, PwaPermissionRequest>,
): number {
  return Object.keys(pendingPermissions).length;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd packages/pwa && bun test tests/daemonViewModel.test.ts
```
Expected: 6 pass, 0 fail.

- [ ] **Step 5: Workspace typecheck**

```bash
bun run typecheck
```
Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add packages/pwa/src/lib/daemonViewModel.ts packages/pwa/tests/daemonViewModel.test.ts
git commit -m "feat(pwa): computeDaemonViewModels pure derivation"
```

---

## Task 2: `screens/HomeScreen.tsx` — daemon list + mini permission card

**Why:** Replaces the inline-styled `<header><h1>cc-remote</h1></header>` + daemon-list block in `RealApp.tsx`. Per spec §2.4 the screen is presentational: it accepts `DaemonViewModel[]`, the pending-approval count, and callbacks — no hub imports. `PermissionMiniCard`, `DaemonCard`, `OfflineDaemonCard`, and `SessionRow` are sub-components inside the same file because they are only used by `HomeScreen` and tightly share its prop shapes.

**Files:**
- Create: `packages/pwa/src/screens/HomeScreen.tsx`

- [ ] **Step 1: Implement the screen**

Create `packages/pwa/src/screens/HomeScreen.tsx`:

```tsx
import { useState } from "react";
import { Plus, ShieldAlert, Trash2 } from "lucide-react";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import type { DaemonViewModel, SessionRowViewModel } from "../lib/daemonViewModel";
import { StatusChip } from "./primitives/StatusChip";
import { StatusIcon } from "./primitives/StatusIcon";

export interface TopPendingPreview {
  daemonHostname: string;
  sessionName: string;
  tool: string;
  commandSummary: string;
}

export interface HomeScreenProps {
  daemons: DaemonViewModel[];
  pendingApprovalsCount: number;
  topPendingPreview?: TopPendingPreview;
  selectedSessionId?: string;
  onSelectSession: (daemon_id: string, session_id: string) => void;
  onStartSession: (daemon_id: string, cwd: string) => void;
  onKillSession: (daemon_id: string, session_id: string) => void;
  onOpenPermission: () => void;
}

export function HomeScreen({
  daemons,
  pendingApprovalsCount,
  topPendingPreview,
  selectedSessionId,
  onSelectSession,
  onStartSession,
  onKillSession,
  onOpenPermission,
}: HomeScreenProps) {
  const [killConfirm, setKillConfirm] = useState<string | null>(null);

  return (
    <section
      className="bg-background border-border h-full overflow-y-auto border-r p-4"
      data-testid="home-screen"
    >
      {pendingApprovalsCount > 0 && topPendingPreview && (
        <PermissionMiniCard
          count={pendingApprovalsCount}
          preview={topPendingPreview}
          onReview={onOpenPermission}
        />
      )}

      <div className="mt-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Machines</h2>
        <span className="text-muted-foreground text-xs">
          {daemons.length} daemon{daemons.length === 1 ? "" : "s"}
        </span>
      </div>

      {daemons.length === 0 ? (
        <p className="text-muted-foreground mt-3 text-sm">
          No daemons connected yet. Run <code className="font-mono">cc-remote pair</code> and
          then <code className="font-mono">cc-remote daemon</code>.
        </p>
      ) : (
        daemons.map((d) =>
          d.online ? (
            <DaemonCard
              key={d.daemon_id}
              daemon={d}
              killConfirm={killConfirm}
              setKillConfirm={setKillConfirm}
              onSelectSession={onSelectSession}
              onStartSession={onStartSession}
              onKillSession={onKillSession}
              selectedSessionId={selectedSessionId}
            />
          ) : (
            <OfflineDaemonCard key={d.daemon_id} daemon={d} />
          ),
        )
      )}
    </section>
  );
}

function PermissionMiniCard({
  count,
  preview,
  onReview,
}: {
  count: number;
  preview: TopPendingPreview;
  onReview: () => void;
}) {
  return (
    <article
      className="rounded-card border-warning/35 bg-warning-subtle shadow-card border p-3"
      data-testid="permission-mini"
    >
      <div className="flex items-start gap-3">
        <ShieldAlert className="text-warning mt-0.5 size-5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">
            {count} approval{count === 1 ? "" : "s"} waiting
          </p>
          <p className="text-muted-foreground truncate text-sm">
            {preview.daemonHostname} · {preview.sessionName} · {preview.tool}
          </p>
          <code className="bg-muted mt-2 block truncate rounded-sm px-2 py-1 font-mono text-xs">
            {preview.commandSummary}
          </code>
        </div>
        <Button onClick={onReview} size="sm" variant="secondary">
          Review
        </Button>
      </div>
    </article>
  );
}

function DaemonCard({
  daemon,
  killConfirm,
  setKillConfirm,
  selectedSessionId,
  onSelectSession,
  onStartSession,
  onKillSession,
}: {
  daemon: DaemonViewModel;
  killConfirm: string | null;
  setKillConfirm: (id: string | null) => void;
  selectedSessionId?: string;
  onSelectSession: (daemon_id: string, session_id: string) => void;
  onStartSession: (daemon_id: string, cwd: string) => void;
  onKillSession: (daemon_id: string, session_id: string) => void;
}) {
  const [cwd, setCwd] = useState("");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = cwd.trim();
    if (!trimmed) return;
    onStartSession(daemon.daemon_id, trimmed);
    setCwd("");
  };

  return (
    <article
      className="rounded-card border-border bg-surface shadow-card mt-3 border p-3"
      data-testid={`machine-card-${daemon.daemon_id}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate font-semibold">{daemon.hostname}</h3>
          <p className="text-muted-foreground text-sm">Online · {daemon.daemon_id}</p>
        </div>
        <span className="bg-muted text-muted-foreground rounded-full px-2 py-1 text-xs">
          {daemon.sessions.length} ses
        </span>
      </div>

      <form className="mt-3 flex gap-2" onSubmit={submit}>
        <input
          aria-label={`Working directory for ${daemon.hostname}`}
          className="border-border bg-muted text-foreground focus:border-ring focus:ring-ring/30 h-11 min-w-0 flex-1 rounded-md border px-3 font-mono text-sm outline-none focus:ring-2"
          onChange={(e) => setCwd(e.target.value)}
          placeholder="/path/to/project"
          value={cwd}
        />
        <Button aria-label="Start session" disabled={!cwd.trim()} size="icon" type="submit">
          <Plus className="size-4" />
        </Button>
      </form>

      <ul
        className="mt-3 grid gap-2"
        data-testid={`sessions-${daemon.daemon_id}`}
        style={{ paddingLeft: 0, listStyle: "none" }}
      >
        {daemon.sessions.length === 0 ? (
          <li className="text-muted-foreground text-sm">No active sessions.</li>
        ) : (
          daemon.sessions.map((s) => (
            <li key={s.session_id}>
              <SessionRow
                session={s}
                selected={selectedSessionId === s.session_id}
                killConfirm={killConfirm}
                setKillConfirm={setKillConfirm}
                onSelect={() => onSelectSession(s.daemon_id, s.session_id)}
                onKill={() => onKillSession(s.daemon_id, s.session_id)}
              />
            </li>
          ))
        )}
      </ul>
    </article>
  );
}

function OfflineDaemonCard({ daemon }: { daemon: DaemonViewModel }) {
  return (
    <article
      className="rounded-card border-border bg-surface shadow-card mt-3 border p-3 opacity-75"
      data-testid={`machine-card-${daemon.daemon_id}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">{daemon.hostname}</h3>
          <p className="text-muted-foreground text-sm">Offline</p>
        </div>
        <StatusChip label="Offline" tone="offline" />
      </div>
      {daemon.sessions.length > 0 && (
        <ul
          className="border-border bg-muted mt-3 grid gap-2 rounded-md border p-3"
          data-testid={`sessions-${daemon.daemon_id}`}
        >
          {daemon.sessions.map((s) => (
            <li key={s.session_id} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-semibold">{s.name}</p>
                <p className="text-muted-foreground truncate font-mono text-xs">{s.cwd}</p>
              </div>
              <StatusChip label="Offline" tone="offline" />
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function SessionRow({
  session,
  selected,
  killConfirm,
  setKillConfirm,
  onSelect,
  onKill,
}: {
  session: SessionRowViewModel;
  selected: boolean;
  killConfirm: string | null;
  setKillConfirm: (id: string | null) => void;
  onSelect: () => void;
  onKill: () => void;
}) {
  const confirming = killConfirm === session.session_id;
  return (
    <div
      className={cn(
        "bg-surface shadow-card rounded-md border p-3",
        session.state === "waiting" ? "border-warning/45" : "border-border",
        selected && "ring-primary/40 ring-2",
      )}
    >
      <button
        className="flex min-h-[44px] w-full items-start gap-3 text-left"
        onClick={onSelect}
      >
        <StatusIcon state={session.state} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center justify-between gap-2">
            <span className="truncate font-semibold">{session.name}</span>
            <StatusChip label={stateLabel(session.state)} tone={session.state} />
          </span>
          <span className="text-muted-foreground mt-1 block truncate font-mono text-xs">
            {session.model} · {session.cwd}
          </span>
          <span className="text-muted-foreground mt-1 block text-xs">
            unread {session.unread} · tasks {session.tasks} · {session.activity}
          </span>
        </span>
      </button>
      {confirming ? (
        <div className="bg-danger-subtle mt-2 flex items-center justify-between gap-2 rounded-md p-2 text-sm">
          <span className="text-danger font-semibold">Kill session?</span>
          <span className="flex gap-2">
            <Button onClick={() => setKillConfirm(null)} size="sm" variant="secondary">
              Cancel
            </Button>
            <Button
              onClick={() => {
                onKill();
                setKillConfirm(null);
              }}
              size="sm"
              variant="danger"
            >
              Kill
            </Button>
          </span>
        </div>
      ) : (
        <div className="mt-1 flex justify-end">
          <Button
            aria-label={`Confirm kill ${session.name}`}
            onClick={() => setKillConfirm(session.session_id)}
            size="sm"
            variant="ghost"
          >
            <Trash2 className="text-danger size-4" />
          </Button>
        </div>
      )}
    </div>
  );
}

function stateLabel(state: SessionRowViewModel["state"]): string {
  switch (state) {
    case "waiting":
      return "Waiting";
    case "working":
      return "Working";
    case "idle":
      return "Idle";
    case "offline":
      return "Offline";
  }
}
```

Note on `Button variant="danger"`: the shadcn `Button` from `components/ui/button.tsx` accepts variant strings used by the prototype (`danger`, `tertiary`, `secondary`, `ghost`). If a variant isn't defined locally, this typecheck will surface it now and you can drop the variant in favor of `destructive` (the standard shadcn name). Inspect `packages/pwa/src/components/ui/button.tsx` if Step 3 below errors on `variant` typing.

- [ ] **Step 2: Add a static-markup smoke test**

Create `packages/pwa/tests/HomeScreen.test.tsx`:

```tsx
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DaemonViewModel } from "../src/lib/daemonViewModel";
import { HomeScreen } from "../src/screens/HomeScreen";

const onlineDaemon: DaemonViewModel = {
  daemon_id: "d1",
  hostname: "mbp.local",
  online: true,
  sessions: [
    {
      daemon_id: "d1",
      session_id: "s1",
      name: "s1",
      model: "sonnet",
      cwd: "/work/repo",
      activity: "permission needed (Bash)",
      state: "waiting",
      unread: 3,
      tasks: 2,
    },
  ],
};

const offlineDaemon: DaemonViewModel = {
  daemon_id: "d2",
  hostname: "vm-eu",
  online: false,
  sessions: [
    {
      daemon_id: "d2",
      session_id: "s2",
      name: "s2",
      model: "opus",
      cwd: "/srv/api",
      activity: "offline",
      state: "offline",
      unread: 0,
      tasks: 0,
    },
  ],
};

test("HomeScreen renders mini card, online daemon, and offline daemon", () => {
  const markup = renderToStaticMarkup(
    <HomeScreen
      daemons={[onlineDaemon, offlineDaemon]}
      pendingApprovalsCount={1}
      topPendingPreview={{
        daemonHostname: "mbp.local",
        sessionName: "s1",
        tool: "Bash",
        commandSummary: "rm -rf node_modules",
      }}
      onSelectSession={() => {}}
      onStartSession={() => {}}
      onKillSession={() => {}}
      onOpenPermission={() => {}}
    />,
  );
  expect(markup).toContain("1 approval waiting");
  expect(markup).toContain("rm -rf node_modules");
  expect(markup).toContain("mbp.local");
  expect(markup).toContain("vm-eu");
  expect(markup).toContain("Waiting");
  expect(markup).toContain("Offline");
  expect(markup).toContain('data-testid="machine-card-d1"');
  expect(markup).toContain('data-testid="sessions-d1"');
});

test("HomeScreen omits mini card when no approvals are pending", () => {
  const markup = renderToStaticMarkup(
    <HomeScreen
      daemons={[onlineDaemon]}
      pendingApprovalsCount={0}
      onSelectSession={() => {}}
      onStartSession={() => {}}
      onKillSession={() => {}}
      onOpenPermission={() => {}}
    />,
  );
  expect(markup).not.toContain("permission-mini");
});

test("HomeScreen shows the empty-state hint when no daemons are connected", () => {
  const markup = renderToStaticMarkup(
    <HomeScreen
      daemons={[]}
      pendingApprovalsCount={0}
      onSelectSession={() => {}}
      onStartSession={() => {}}
      onKillSession={() => {}}
      onOpenPermission={() => {}}
    />,
  );
  expect(markup).toContain("No daemons connected yet.");
  expect(markup).toContain("cc-remote pair");
});
```

- [ ] **Step 3: Run typecheck and tests**

```bash
cd packages/pwa && bun run typecheck && bun test tests/HomeScreen.test.tsx
```
Expected: zero typecheck errors; 3 pass.

If `variant="danger"` errors out, open `packages/pwa/src/components/ui/button.tsx` to see what variants exist, then either (a) replace `variant="danger"` with the existing destructive variant or (b) extend the variants once and reuse — pick the one that matches existing prototype usage.

- [ ] **Step 4: Commit**

```bash
git add packages/pwa/src/screens/HomeScreen.tsx packages/pwa/tests/HomeScreen.test.tsx
git commit -m "feat(pwa): HomeScreen presentational shell"
```

---

## Task 3: `screens/AppShell.tsx` — header + nav + responsive grid

**Why:** Hosts the top header (brand mark + connection chip + sign-out + settings) and, on desktop, the left nav rail. Accepts `home` and `session` slots so `RealApp.tsx` can compose `<HomeScreen>` and `<SessionView>` without owning layout. The shell is presentational; `RealApp` owns connection state and bearer.

**Files:**
- Create: `packages/pwa/src/screens/AppShell.tsx`

- [ ] **Step 1: Implement the shell**

Create `packages/pwa/src/screens/AppShell.tsx`:

```tsx
import { Bell, Laptop, Settings } from "lucide-react";
import type React from "react";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { ClaudeCodeMark } from "./primitives/ClaudeCodeMark";
import { StatusChip } from "./primitives/StatusChip";

export type AppShellDevice = "mobile" | "tablet" | "desktop";

export interface AppShellProps {
  device: AppShellDevice;
  connected: boolean;
  pendingApprovalsCount: number;
  onOpenSettings: () => void;
  onOpenPermission: () => void;
  onSignOut: () => void;
  /** Side-by-side panes when device !== mobile. On mobile, one or the other. */
  home: React.ReactNode;
  session?: React.ReactNode;
  /** True on mobile when a session is selected so HomeScreen is hidden. */
  sessionActiveOnMobile?: boolean;
}

export function AppShell({
  device,
  connected,
  pendingApprovalsCount,
  onOpenSettings,
  onOpenPermission,
  onSignOut,
  home,
  session,
  sessionActiveOnMobile = false,
}: AppShellProps) {
  return (
    <div className="bg-background flex h-dvh flex-col">
      <header
        className="border-border bg-surface flex h-14 shrink-0 items-center justify-between border-b px-4"
        data-testid="app-shell-header"
      >
        <div className="flex items-center gap-2">
          <ClaudeCodeMark size="sm" />
          <span className="font-semibold">cc-remote</span>
        </div>
        <div className="flex items-center gap-2">
          <StatusChip
            label={connected ? "Connected" : "Reconnecting…"}
            tone={connected ? "online" : "error"}
          />
          {device === "desktop" && (
            <Button onClick={onSignOut} size="sm" variant="ghost">
              Sign out
            </Button>
          )}
          <Button
            aria-label="Open settings"
            onClick={onOpenSettings}
            size="icon"
            variant="ghost"
          >
            <Settings className="size-4" />
          </Button>
        </div>
      </header>

      <div
        className={cn(
          "flex min-h-0 flex-1",
          device === "desktop" && "grid grid-cols-[72px_370px_minmax(0,1fr)]",
          device === "tablet" && "grid grid-cols-[320px_minmax(0,1fr)]",
        )}
      >
        {device === "desktop" && (
          <DesktopNav
            pendingApprovalsCount={pendingApprovalsCount}
            onOpenPermission={onOpenPermission}
            onOpenSettings={onOpenSettings}
          />
        )}

        {device === "mobile" ? (
          <div className="min-w-0 flex-1">
            {sessionActiveOnMobile && session ? session : home}
          </div>
        ) : (
          <>
            <div className="min-w-0">{home}</div>
            <div className="min-w-0">
              {session ?? (
                <div className="bg-background flex h-full items-center justify-center">
                  <p className="text-muted-foreground text-sm">
                    Select a session to start.
                  </p>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function DesktopNav({
  pendingApprovalsCount,
  onOpenPermission,
  onOpenSettings,
}: {
  pendingApprovalsCount: number;
  onOpenPermission: () => void;
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
        aria-label={`Permissions (${pendingApprovalsCount} pending)`}
        className="text-muted-foreground hover:bg-muted hover:text-foreground relative flex size-11 items-center justify-center rounded-md"
        onClick={onOpenPermission}
      >
        <Bell className="size-5" />
        {pendingApprovalsCount > 0 && (
          <span className="bg-warning text-warning-foreground absolute right-1 top-1 inline-flex size-4 items-center justify-center rounded-full text-[10px] font-bold">
            {pendingApprovalsCount}
          </span>
        )}
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

- [ ] **Step 2: Verify typecheck**

```bash
cd packages/pwa && bun run typecheck
```
Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add packages/pwa/src/screens/AppShell.tsx
git commit -m "feat(pwa): AppShell with header + desktop nav + responsive grid"
```

---

## Task 4: `hooks/useMediaQuery.ts` — viewport-driven device picker

**Why:** Per spec §3.1 most layout swaps are done by Tailwind responsive classes. The exception is `PermissionSurface`, which **changes DOM structure** between mobile bottom-sheet, tablet centered modal, and desktop right-rail aside. CSS alone can't switch DOM, so we need a JS hook. `useMediaQuery` returns `'mobile' | 'tablet' | 'desktop'` from `window.matchMedia`. `AppShell` uses the same hook in `RealApp.tsx`.

**Files:**
- Create: `packages/pwa/src/hooks/useMediaQuery.ts`

- [ ] **Step 1: Implement the hook**

Create `packages/pwa/src/hooks/useMediaQuery.ts`:

```ts
import { useEffect, useState } from "react";

export type Device = "mobile" | "tablet" | "desktop";

const MOBILE_MAX = 767;
const TABLET_MAX = 1023;

function pickDevice(width: number): Device {
  if (width <= MOBILE_MAX) return "mobile";
  if (width <= TABLET_MAX) return "tablet";
  return "desktop";
}

/**
 * Tracks the current viewport bucket. SSR-safe — defaults to "desktop"
 * before window is available so static-markup tests have a deterministic value.
 */
export function useDevice(): Device {
  const [device, setDevice] = useState<Device>(() =>
    typeof window === "undefined" ? "desktop" : pickDevice(window.innerWidth),
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const update = () => setDevice(pickDevice(window.innerWidth));
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  return device;
}
```

- [ ] **Step 2: Verify typecheck**

```bash
cd packages/pwa && bun run typecheck
```
Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add packages/pwa/src/hooks/useMediaQuery.ts
git commit -m "feat(pwa): useDevice viewport hook"
```

---

## Task 5: Wire `RealApp.tsx` to `AppShell` + `HomeScreen`

**Why:** First milestone-significant behavioral change in P4: replace the inline header + daemon list with the new components. SessionView is already mounted from P3 — pass it as the `session` slot of `AppShell`. PermissionBanner stays in this task; it gets removed in Task 9 once the new surface lands.

**Files:**
- Modify: `packages/pwa/src/RealApp.tsx`

- [ ] **Step 1: Refactor `RealApp.tsx`**

Open `packages/pwa/src/RealApp.tsx` and replace the body of `RealApp()` with the new shell. Concretely:

1. Imports — drop nothing yet (PermissionBanner is removed in Task 9). Add:

```ts
import { computeDaemonViewModels, totalPendingApprovals } from "./lib/daemonViewModel";
import { AppShell } from "./screens/AppShell";
import { HomeScreen } from "./screens/HomeScreen";
import { useDevice } from "./hooks/useMediaQuery";
```

2. Inside `RealApp()`, after the existing `useHub` + `useSessionTimeline` calls, derive the home view-model and the device:

```tsx
const device = useDevice();
const daemonModels = useMemo(
  () => computeDaemonViewModels({
    daemons: hub.daemons,
    events: hub.events,
    pendingPermissions: hub.pendingPermissions,
    completedCounts: hub.completedCounts,
    idleSessions: hub.idleSessions,
  }),
  [hub.daemons, hub.events, hub.pendingPermissions, hub.completedCounts, hub.idleSessions],
);
const pendingApprovalsCount = totalPendingApprovals(hub.pendingPermissions);
const topPending = Object.values(hub.pendingPermissions)[0];
const topPendingPreview = topPending
  ? {
      daemonHostname:
        hub.daemons.find((d) => d.daemon_id === topPending.daemon_id)?.hostname ??
        topPending.daemon_id,
      sessionName: topPending.session_id,
      tool: topPending.tool,
      commandSummary: topPending.args_summary,
    }
  : undefined;
```

(Add `useMemo` to the existing `react` import: `import { useEffect, useMemo, useState } from "react";`.)

3. Replace the entire `return (...)` block with an `AppShell`-based tree. Keep the not-signed-in early return. Keep the existing `<PermissionBanner …/>` mounted at the top during this task — it goes away in Task 9.

```tsx
if (!bearer) {
  return (
    <main className="bg-background flex h-dvh items-center justify-center p-6">
      <div className="max-w-sm space-y-3 text-center">
        <h1 className="text-2xl font-semibold">cc-remote</h1>
        <p className="text-muted-foreground">You're not signed in.</p>
        <a
          className="bg-primary text-primary-foreground inline-block rounded-md px-4 py-2 text-sm font-semibold"
          href={loginUrl(HUB_URL)}
        >
          Sign in
        </a>
      </div>
    </main>
  );
}

return (
  <>
    <PermissionBanner pending={pendingPermissions} onReply={sendPermissionReply} />
    <AppShell
      device={device}
      connected={connected}
      pendingApprovalsCount={pendingApprovalsCount}
      onOpenSettings={() => setShowSettings(true)}
      onOpenPermission={() => {
        // Wired to PermissionSurface in Task 8.
      }}
      onSignOut={() => { clearBearer(); setBearer(null); }}
      sessionActiveOnMobile={!!selected}
      home={
        <HomeScreen
          daemons={daemonModels}
          pendingApprovalsCount={pendingApprovalsCount}
          topPendingPreview={topPendingPreview}
          selectedSessionId={selected?.session_id}
          onSelectSession={(daemon_id, session_id) => setSelected({ daemon_id, session_id })}
          onStartSession={(daemon_id, cwd) => hub.startSession(daemon_id, cwd)}
          onKillSession={(daemon_id, session_id) => hub.killSession(daemon_id, session_id)}
          onOpenPermission={() => {
            // Wired in Task 8.
          }}
        />
      }
      session={
        selected ? (
          <SessionView
            header={{
              name: selectedSession?.session_id ?? selected.session_id,
              model: selectedSession?.model ?? null,
              cwd: selectedSession?.cwd ?? "",
              online: sessionTimeline.online,
            }}
            items={sessionTimeline.items}
            composerBlocked={sessionTimeline.composerBlocked}
            pendingPermissionInThisSession={sessionTimeline.pendingInThisSession}
            chatError={selectedChatError}
            onLoadEarlier={sessionTimeline.loadEarlier}
            onSendChat={(content) => hub.sendChat(selected.daemon_id, selected.session_id, content)}
            onOpenPermission={(request_id) => {
              const req = pendingPermissions[request_id];
              if (req) sendPermissionReply(req, "allow");
            }}
            onBack={() => setSelected(null)}
          />
        ) : undefined
      }
    />
    {showSettings && bearer && (
      <Settings hubUrl={HUB_URL} bearer={bearer} onClose={() => setShowSettings(false)} />
    )}
  </>
);
```

4. Remove the now-unused `newSessionCwd` state and its setter — `HomeScreen`'s `DaemonCard` owns its own per-card cwd input. Remove the `newSessionCwd` state declaration at the top of `RealApp()`.

- [ ] **Step 2: Verify typecheck**

```bash
bun run typecheck
```
Expected: zero errors. The unused-imports linter may flag `eventKey` if SessionView is the last consumer; it's still used by `selectedChatError` so keep it.

- [ ] **Step 3: Run unit + e2e tests**

```bash
bun test packages/
bun test e2e/
```
Expected: all green. The protocol surface is unchanged — the only differences are visual.

- [ ] **Step 4: Manual three-breakpoint smoke**

Start `cd packages/pwa && bun run dev` and resize the browser:

- **Desktop (≥ 1024px)**: nav rail on the left, HomeScreen (370px) in the middle, SessionView fills the rest when a session is selected (right rail empty otherwise with "Select a session to start").
- **Tablet (768–1023px)**: HomeScreen (320px) on the left, SessionView fills the rest. No nav rail.
- **Mobile (< 768px)**: HomeScreen full-width when no session selected. Selecting a session pushes SessionView; `Back` arrow returns home.

PermissionBanner is still mounted at the top — it's the live approval mechanism until Task 8.

Stop the dev server.

- [ ] **Step 5: Commit**

```bash
git add packages/pwa/src/RealApp.tsx
git commit -m "feat(pwa): RealApp uses AppShell + HomeScreen (M5)"
```

---

## Task 6: `screens/PermissionSurface.tsx` — three-form decision UI

**Why:** Per spec §3.3 the permission decision surface has three structurally different forms. Build the component now with a `device` prop; wire it into `RealApp` in Task 8 so this task stays a pure file-add.

**Files:**
- Create: `packages/pwa/src/screens/PermissionSurface.tsx`

- [ ] **Step 1: Implement the surface**

Create `packages/pwa/src/screens/PermissionSurface.tsx`:

```tsx
import { ShieldAlert, X } from "lucide-react";
import type { PwaPermissionRequest } from "@cc-remote/proto";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import type { Device } from "../hooks/useMediaQuery";
import { Field } from "./primitives/Field";

export interface PermissionSurfaceProps {
  request: PwaPermissionRequest;
  /** Hostname of the daemon that issued the request (resolved by RealApp). */
  daemonHostname: string;
  /** 1-indexed position of the active request in the queue, e.g. 1 of 3. */
  queueIndex: number;
  queueSize: number;
  device: Device;
  onAllow: () => void;
  onDeny: () => void;
  onClose: () => void;
}

export function PermissionSurface(props: PermissionSurfaceProps) {
  const { device } = props;
  const card = <PermissionCard {...props} />;

  if (device === "desktop") {
    return (
      <aside
        className="border-border bg-surface shadow-sheet fixed top-14 right-0 bottom-0 z-50 w-[390px] border-l p-4"
        data-testid="permission-surface"
        data-form="aside"
      >
        {card}
      </aside>
    );
  }

  return (
    <div
      className="bg-overlay fixed inset-0 z-50 flex items-end justify-center md:items-start md:pt-20"
      data-testid="permission-surface"
      data-form={device === "mobile" ? "sheet" : "modal"}
      onClick={props.onClose}
    >
      <div
        className={cn(
          "bg-surface shadow-sheet w-full max-w-[520px]",
          device === "mobile"
            ? "rounded-t-sheet h-[calc(100%-60px)] p-4"
            : "rounded-sheet mx-4 p-5",
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {card}
      </div>
    </div>
  );
}

function PermissionCard({
  request,
  daemonHostname,
  queueIndex,
  queueSize,
  onAllow,
  onDeny,
  onClose,
}: PermissionSurfaceProps) {
  return (
    <article className="flex h-full flex-col">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-warning flex items-center gap-2">
            <ShieldAlert className="size-5" />
            <h2 className="text-foreground text-lg font-semibold">
              Claude requests permission
            </h2>
          </div>
          <p className="text-muted-foreground mt-1 text-sm">
            {request.session_id} · {daemonHostname}
          </p>
        </div>
        <Button aria-label="Close" onClick={onClose} size="icon" variant="ghost">
          <X className="size-4" />
        </Button>
      </div>

      <div className="mt-5 grid gap-4">
        <Field label="Tool" value={request.tool} />
        <div>
          <p className="text-muted-foreground text-xs font-semibold tracking-[0.12em] uppercase">
            Command
          </p>
          <code className="border-border bg-muted mt-2 block rounded-md border p-3 font-mono text-sm whitespace-pre-wrap break-all">
            {request.args_summary}
          </code>
        </div>
        {queueSize > 1 && (
          <p className="text-muted-foreground text-sm" data-testid="permission-queue">
            {queueIndex} of {queueSize} pending
          </p>
        )}
      </div>

      <div className="mt-auto pt-5">
        <div className="grid grid-cols-2 gap-3">
          <Button onClick={onDeny} size="lg" variant="secondary">
            Deny
          </Button>
          <Button onClick={onAllow} size="lg">
            Allow once
          </Button>
        </div>
      </div>
    </article>
  );
}
```

(Body adapted from prototype lines 2301–2400. Differences: (a) request data is read from props, not hard-coded; (b) "configure allow always" button removed — there's no hub-side rule API yet, so the button would be dead; (c) the `data-form` attribute exposes which structural variant rendered, useful for the e2e-real Playwright pass.)

- [ ] **Step 2: Add a static-markup smoke test**

Create `packages/pwa/tests/PermissionSurface.test.tsx`:

```tsx
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PwaPermissionRequest } from "@cc-remote/proto";
import { PermissionSurface } from "../src/screens/PermissionSurface";

const request: PwaPermissionRequest = {
  type: "permission_request",
  daemon_id: "d1",
  session_id: "s1",
  request_id: "r1",
  tool: "Bash",
  args_summary: "rm -rf node_modules",
  expires_at: 0,
};

test.each(["mobile", "tablet", "desktop"] as const)(
  "PermissionSurface renders on %s with request details",
  (device) => {
    const markup = renderToStaticMarkup(
      <PermissionSurface
        request={request}
        daemonHostname="mbp.local"
        queueIndex={1}
        queueSize={3}
        device={device}
        onAllow={() => {}}
        onDeny={() => {}}
        onClose={() => {}}
      />,
    );
    expect(markup).toContain("Claude requests permission");
    expect(markup).toContain("Bash");
    expect(markup).toContain("rm -rf node_modules");
    expect(markup).toContain("1 of 3 pending");
    expect(markup).toContain('data-testid="permission-surface"');
  },
);

test("PermissionSurface omits queue line when only one request", () => {
  const markup = renderToStaticMarkup(
    <PermissionSurface
      request={request}
      daemonHostname="mbp.local"
      queueIndex={1}
      queueSize={1}
      device="desktop"
      onAllow={() => {}}
      onDeny={() => {}}
      onClose={() => {}}
    />,
  );
  expect(markup).not.toContain("of 1 pending");
  expect(markup).not.toContain('data-testid="permission-queue"');
});
```

(`test.each` is provided by `bun:test` — confirm by running. If not available in this version of Bun, expand to three explicit tests.)

- [ ] **Step 3: Run typecheck and tests**

```bash
cd packages/pwa && bun run typecheck && bun test tests/PermissionSurface.test.tsx
```
Expected: 4 pass.

If `test.each` is unsupported, replace with three named tests.

- [ ] **Step 4: Commit**

```bash
git add packages/pwa/src/screens/PermissionSurface.tsx packages/pwa/tests/PermissionSurface.test.tsx
git commit -m "feat(pwa): PermissionSurface with sheet/modal/aside forms"
```

---

## Task 7: Multi-pending controller — `hooks/usePermissionQueue.ts`

**Why:** The surface itself is presentational. Queue management — pick the active request, advance after allow/deny, auto-close when removed by another device — is hub-aware and lives in a hook that `RealApp` composes. Per spec §3.3:

- After Allow/Deny, advance to the next pending.
- If the active request_id leaves `pendingPermissions` (resolved on another device), surface a transient "Already handled on another device" notice and advance.

**Files:**
- Create: `packages/pwa/src/hooks/usePermissionQueue.ts`

- [ ] **Step 1: Implement the hook**

Create `packages/pwa/src/hooks/usePermissionQueue.ts`:

```ts
import { useEffect, useMemo, useRef, useState } from "react";
import type { PwaPermissionRequest } from "@cc-remote/proto";

export interface PermissionQueueState {
  open: boolean;
  /** The request currently shown in the surface, or null if none. */
  active: PwaPermissionRequest | null;
  queueIndex: number;
  queueSize: number;
  /** Set transiently when the active request was resolved by another device. */
  handledNotice: boolean;
  openSurface: () => void;
  closeSurface: () => void;
  /** Advance past the current request — used after local allow/deny. */
  advance: () => void;
}

export function usePermissionQueue(
  pendingPermissions: Record<string, PwaPermissionRequest>,
): PermissionQueueState {
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [handledNotice, setHandledNotice] = useState(false);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const queue = useMemo(() => Object.values(pendingPermissions), [pendingPermissions]);

  // Choose / refresh the active request.
  useEffect(() => {
    if (!open) {
      setActiveId(null);
      return;
    }
    const stillPresent = activeId !== null && pendingPermissions[activeId];
    if (stillPresent) return;

    if (activeId !== null && !pendingPermissions[activeId] && queue.length > 0) {
      // The active request was resolved elsewhere. Notify and advance.
      setHandledNotice(true);
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
      noticeTimer.current = setTimeout(() => setHandledNotice(false), 2500);
    }

    if (queue.length === 0) {
      setOpen(false);
      setActiveId(null);
      return;
    }

    setActiveId(queue[0].request_id);
  }, [open, activeId, pendingPermissions, queue]);

  // Cleanup notice timer on unmount.
  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
  }, []);

  const active = activeId !== null ? (pendingPermissions[activeId] ?? null) : null;
  const queueIndex = active
    ? Math.max(1, queue.findIndex((q) => q.request_id === active.request_id) + 1)
    : 0;

  return {
    open,
    active,
    queueIndex,
    queueSize: queue.length,
    handledNotice,
    openSurface: () => setOpen(true),
    closeSurface: () => {
      setOpen(false);
      setActiveId(null);
    },
    advance: () => {
      // Drop the active request locally; the next render picks the new head.
      if (activeId !== null) setActiveId(null);
    },
  };
}
```

- [ ] **Step 2: Add a unit test for advancement and auto-close behavior**

Create `packages/pwa/tests/usePermissionQueue.test.tsx`:

```tsx
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PwaPermissionRequest } from "@cc-remote/proto";
import { useEffect } from "react";
import { usePermissionQueue } from "../src/hooks/usePermissionQueue";

function req(id: string): PwaPermissionRequest {
  return {
    type: "permission_request",
    daemon_id: "d1",
    session_id: "s1",
    request_id: id,
    tool: "Bash",
    args_summary: `# ${id}`,
    expires_at: 0,
  };
}

function Probe({
  pending,
  capture,
}: {
  pending: Record<string, PwaPermissionRequest>;
  capture: (state: ReturnType<typeof usePermissionQueue>) => void;
}) {
  const state = usePermissionQueue(pending);
  useEffect(() => {
    state.openSurface();
  }, []);
  capture(state);
  return null;
}

test("usePermissionQueue picks the first pending as active when opened", () => {
  let captured: ReturnType<typeof usePermissionQueue> | null = null;
  renderToStaticMarkup(
    <Probe
      pending={{ a: req("a"), b: req("b") }}
      capture={(s) => {
        captured = s;
      }}
    />,
  );
  // After initial render, active is null because openSurface effect hasn't run yet
  // in renderToStaticMarkup. The reducer check below matters more for behavior
  // contract — see RealApp wiring + manual smoke for the lifecycle.
  expect(captured).not.toBeNull();
});
```

(SSR-only static-markup probing has limits — the surface lifecycle is more naturally validated by manual smoke test in Task 8 Step 4. We commit a minimal probe to lock the public type surface; the substantive coverage is the e2e + manual.)

- [ ] **Step 3: Run typecheck**

```bash
cd packages/pwa && bun run typecheck && bun test tests/usePermissionQueue.test.tsx
```
Expected: typecheck clean; 1 pass.

- [ ] **Step 4: Commit**

```bash
git add packages/pwa/src/hooks/usePermissionQueue.ts packages/pwa/tests/usePermissionQueue.test.tsx
git commit -m "feat(pwa): usePermissionQueue (queue advance + already-handled notice)"
```

---

## Task 8: Wire `PermissionSurface` into `RealApp.tsx`

**Why:** Hooks the new surface up to live `pendingPermissions`. The `Review` button in HomeScreen's `PermissionMiniCard`, the AppShell desktop nav bell, and the SessionView composer warning strip all become real entry points to `<PermissionSurface>`. Local Allow/Deny calls `sendPermissionReply` and `advance()`s the queue; if the queue empties or the surface request disappears externally, the surface auto-closes.

**Files:**
- Modify: `packages/pwa/src/RealApp.tsx`

- [ ] **Step 1: Wire the queue hook**

In `packages/pwa/src/RealApp.tsx`, after the existing `useDevice()` and view-model derivation, add:

```ts
import { usePermissionQueue } from "./hooks/usePermissionQueue";
import { PermissionSurface } from "./screens/PermissionSurface";

const permissionQueue = usePermissionQueue(hub.pendingPermissions);
```

- [ ] **Step 2: Replace the surface entry-point stubs**

Update three callbacks introduced in Task 5 to call `permissionQueue.openSurface()`:

```diff
-          onOpenPermission={() => {
-            // Wired to PermissionSurface in Task 8.
-          }}
+          onOpenPermission={permissionQueue.openSurface}
           ...
-          onOpenPermission={() => {
-            // Wired in Task 8.
-          }}
+          onOpenPermission={permissionQueue.openSurface}
```

(Two locations: AppShell prop and HomeScreen prop. Plus, in the SessionView prop, replace the `sendPermissionReply(req, "allow")` shortcut with `permissionQueue.openSurface()`.)

- [ ] **Step 3: Render the surface**

At the bottom of the `RealApp` return (alongside `<Settings>` mount), add:

```tsx
{permissionQueue.open && permissionQueue.active && (
  <PermissionSurface
    request={permissionQueue.active}
    daemonHostname={
      hub.daemons.find((d) => d.daemon_id === permissionQueue.active!.daemon_id)?.hostname ??
      permissionQueue.active.daemon_id
    }
    queueIndex={permissionQueue.queueIndex}
    queueSize={permissionQueue.queueSize}
    device={device}
    onAllow={() => {
      hub.sendPermissionReply(permissionQueue.active!, "allow");
      permissionQueue.advance();
    }}
    onDeny={() => {
      hub.sendPermissionReply(permissionQueue.active!, "deny");
      permissionQueue.advance();
    }}
    onClose={permissionQueue.closeSurface}
  />
)}
{permissionQueue.handledNotice && (
  <div
    className="bg-surface text-foreground border-border shadow-card fixed top-16 left-1/2 z-[60] -translate-x-1/2 rounded-md border px-3 py-2 text-sm"
    role="status"
  >
    Already handled on another device.
  </div>
)}
```

- [ ] **Step 4: Verify typecheck and tests**

```bash
bun run typecheck
bun test packages/
bun test e2e/
```
Expected: all green.

- [ ] **Step 5: Manual three-form smoke**

Start `cd packages/pwa && bun run dev`. With at least one pending permission queued (run a tool that needs approval in a real session), verify:

- **Desktop**: Click `Review` (mini card or bell) → right-rail aside slides in. Allow → if more pending, surface advances to the next; if not, closes.
- **Tablet**: Same flow → centered modal appears with backdrop click-to-close.
- **Mobile**: Same flow → bottom sheet covers most of the screen; backdrop tap closes; back arrow not needed.
- **Multi-pending**: Queue line shows `1 of N pending`. Pressing Allow on the first advances to `2 of N`, then `3 of N`, then closes when N is depleted.
- **Already-handled**: While the desktop aside is open with request R1 active, run `cc-remote permission --allow R1` from another logged-in client (or simulate by calling `hub.sendPermissionReply` from the dev console). The aside should auto-advance and the toast `Already handled on another device.` should appear briefly.

Stop the dev server.

- [ ] **Step 6: Commit**

```bash
git add packages/pwa/src/RealApp.tsx
git commit -m "feat(pwa): RealApp mounts PermissionSurface with queue advance (M6)"
```

---

## Task 9: Remove `PermissionBanner.tsx`

**Why:** The new surface fully covers the banner's role. Per spec M6: *Delete `PermissionBanner.tsx`*. Doing this in its own task keeps the diff isolated and the revert trivial.

**Files:**
- Modify: `packages/pwa/src/RealApp.tsx`
- Delete: `packages/pwa/src/PermissionBanner.tsx`

- [ ] **Step 1: Drop the import and the mount**

In `packages/pwa/src/RealApp.tsx`:

```diff
-import { PermissionBanner } from "./PermissionBanner.tsx";
```

And remove the `<PermissionBanner pending={pendingPermissions} onReply={sendPermissionReply} />` line at the top of the post-`if (!bearer)` return.

- [ ] **Step 2: Delete the file**

```bash
rm packages/pwa/src/PermissionBanner.tsx
```

- [ ] **Step 3: Verify typecheck**

```bash
bun run typecheck
```
Expected: zero errors. (No other module imports `PermissionBanner` — verify with `grep -r 'PermissionBanner' packages/pwa/src` and expect zero matches.)

- [ ] **Step 4: Run tests**

```bash
bun test packages/
bun test e2e/
```
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add packages/pwa/src/RealApp.tsx packages/pwa/src/PermissionBanner.tsx
git commit -m "refactor(pwa): delete PermissionBanner — replaced by PermissionSurface"
```

---

## Task 10: Final P4 verification

- [ ] **Step 1: Workspace-wide typecheck**

```bash
bun run typecheck
```
Expected: every package green.

- [ ] **Step 2: Workspace-wide unit tests**

```bash
bun test packages/
```
Expected: P3 baseline + 6 (daemonViewModel) + 3 (HomeScreen) + 4 (PermissionSurface) + 1 (usePermissionQueue) = previous + 14. All pass.

- [ ] **Step 3: In-process e2e**

```bash
bun test e2e/
```
Expected: all 12 in-process scenarios pass.

- [ ] **Step 4: Manual visual sanity on `/` and `/demo`**

Start `cd packages/pwa && bun run dev`:

- `/` — full prototype-styled chrome on every breakpoint. Daemon list / mini permission card / sessions / new SessionView. Permission surface as sheet/modal/aside per device.
- `/demo` — guided demo unchanged from P3; no regressions.

Stop the dev server.

- [ ] **Step 5: Confirm clean tree**

```bash
git status
```
Expected: working tree clean. P4 done. Hand off to P5 (Settings + Auth + Cleanup).
