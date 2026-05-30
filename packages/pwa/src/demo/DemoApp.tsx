import {
  ArrowLeft,
  Copy,
  MoreHorizontal,
  Monitor,
  Moon,
  Plus,
  Send,
  Settings,
  Smartphone,
  Sun,
  Tablet,
  Trash2,
  X,
} from "lucide-react";
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { ClaudeAvatar } from "../screens/primitives/ClaudeAvatar";
import { ClaudeCodeMark } from "../screens/primitives/ClaudeCodeMark";
import { InlinePermissionCard } from "../screens/primitives/InlinePermissionCard";
import { StatusChip, type SessionState } from "../screens/primitives/StatusChip";
import { StatusIcon } from "../screens/primitives/StatusIcon";
import { Spinner, TypingIndicator } from "../screens/primitives/TypingIndicator";
import { SlashMenu } from "../screens/primitives/SlashMenu";
import { renderTimelineItem } from "../screens/timeline/renderTimelineItem";
import { groupTimelineItems } from "../screens/timeline/groupTimelineItems";
import { renderTimelineGroup } from "../screens/timeline/renderTimelineGroup";
import type { RenderItem } from "../screens/timeline/types";
import { EventType } from "@cc-remote/proto";
import type {
  PwaPermissionRequest,
  SlashEntry,
  TextMessageChunkEvent,
  ToolCallChunkEvent,
  ToolCallResultEvent,
} from "@cc-remote/proto";

/**
 * DemoApp — interactive product demo.
 *
 * Renders the real app's surfaces (Home → Session with inline permission
 * card → Settings drawer) inside a switchable device frame. There is no
 * guided rail / step list; the only top-level chrome is a device pill
 * row and a theme toggle. Everything inside the frame is driven by real
 * tap interactions, so the demo behaves like the shipped app.
 *
 * State is purely local and scoped to this component — no hub, no daemon
 * sockets. The flow is deliberately small but covers the money moments:
 *   - Tap a session → opens SessionView with timeline
 *   - The "repo-web" session has a pending permission card
 *   - Allow/Deny goes through a fake roundtrip then resolves
 *   - Kill confirmation expands inline within a session row
 *   - Settings opens as a drawer/sheet appropriate to the device
 */

type Device = "mobile" | "tablet" | "desktop";
type Theme = "light" | "dark";
type Screen = "home" | "session";
type View = "live" | "catalog";

const devices: Array<{ id: Device; label: string; icon: typeof Smartphone }> = [
  { id: "mobile", label: "Mobile", icon: Smartphone },
  { id: "tablet", label: "Tablet", icon: Tablet },
  { id: "desktop", label: "Desktop", icon: Monitor },
];

interface SessionRecord {
  id: string;
  daemonId: string;
  name: string;
  model: string;
  cwd: string;
  activity: string;
  state: SessionState;
  unread: number;
  tasks: number;
  lastSeen: string;
}

/* Per-session timeline state — initial events are mocked, but live `send`
   events from the demo composer get appended in real time so the user can
   feel the "user msg → typing dots → assistant reply" rhythm. */
type TimelineState = Record<string, RenderItem[]>;

const initialSessions: SessionRecord[] = [
  {
    id: "s_repo",
    daemonId: "mbp-m3",
    name: "repo-web",
    model: "sonnet",
    cwd: "/Users/me/repo-web",
    activity: "permission needed",
    state: "waiting",
    unread: 2,
    tasks: 7,
    lastSeen: "now",
  },
  {
    id: "s_api",
    daemonId: "mbp-m3",
    name: "api-server",
    model: "opus",
    cwd: "/Users/me/api",
    activity: "running tool",
    state: "working",
    unread: 0,
    tasks: 12,
    lastSeen: "now",
  },
  {
    id: "s_tools",
    daemonId: "mbp-m3",
    name: "cli-tools",
    model: "sonnet",
    cwd: "/Users/me/tools",
    activity: "idle 8m",
    state: "idle",
    unread: 0,
    tasks: 3,
    lastSeen: "8m ago",
  },
  {
    id: "s_infra",
    daemonId: "dev-vm-eu",
    name: "infra",
    model: "sonnet",
    cwd: "/terraform",
    activity: "paused",
    state: "offline",
    unread: 0,
    tasks: 4,
    lastSeen: "12m ago",
  },
];

const stateLabel = (state: SessionState): string => {
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
};

interface PermissionState {
  request: PwaPermissionRequest;
  /** "pending" while a decision is in flight; resolved → cleared from state. */
  submitting: "allow" | "deny" | null;
}

const initialPermission: PermissionState = {
  request: {
    type: "permission_request",
    daemon_id: "mbp-m3",
    session_id: "s_repo",
    request_id: "req_a3f8b9d2",
    tool: "Bash",
    args_summary: "rm -rf node_modules",
    expires_at: Date.now() + 60_000,
  },
  submitting: null,
};

/**
 * Mock slash inventory — what `/` autocomplete shows in the demo. These
 * are realistic shapes (built-in / project / user / skill) so the menu's
 * source-chip styling can be evaluated. The first slash command actually
 * "runs" via the demo's chat send path so the user can see the round-trip.
 */
const mockSlashEntries: SlashEntry[] = [
  {
    id: "builtin:clear",
    name: "/clear",
    description: "Clear conversation history and free context",
    source: "builtin",
  },
  {
    id: "builtin:help",
    name: "/help",
    description: "Show usage information and current settings",
    source: "builtin",
  },
  {
    id: "builtin:compact",
    name: "/compact",
    description: "Summarize the conversation to save tokens",
    argument_hint: "[focus]",
    source: "builtin",
  },
  {
    id: "builtin:cost",
    name: "/cost",
    description: "Show total token usage and cost for this session",
    source: "builtin",
  },
  {
    id: "skill:brainstorming",
    name: "/brainstorming",
    description: "Explore intent and requirements before writing code",
    source: "skill",
  },
  {
    id: "skill:commit",
    name: "/commit",
    description: "Create a well-formatted conventional commit",
    source: "skill",
  },
  {
    id: "skill:code-review",
    name: "/code-review",
    description: "Review the current diff for bugs and cleanups",
    argument_hint: "[--effort=high]",
    source: "skill",
  },
  {
    id: "project:run-tests",
    name: "/run-tests",
    description: "Run the project's test suite via pnpm",
    argument_hint: "[scope]",
    source: "project",
  },
  {
    id: "project:deploy-staging",
    name: "/deploy-staging",
    description: "Deploy current branch to staging",
    source: "project",
  },
  {
    id: "user:standup",
    name: "/standup",
    description: "Summarize what I worked on yesterday",
    source: "user",
  },
];

export function DemoApp() {
  const [device, setDevice] = useState<Device>("mobile");
  const [theme, setTheme] = useState<Theme>("light");
  const [view, setView] = useState<View>("live");
  const [screen, setScreen] = useState<Screen>("home");
  const [selectedSessionId, setSelectedSessionId] = useState<string>("s_repo");
  const [killConfirm, setKillConfirm] = useState<string | null>(null);
  /** Sessions whose Kill confirm was actually pressed — row dims + spinner
      until removal completes. */
  const [killing, setKilling] = useState<Set<string>>(() => new Set());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sessions, setSessions] = useState(initialSessions);
  const [permission, setPermission] = useState<PermissionState | null>(
    initialPermission,
  );
  /** Per-session timeline. The repo-web session is seeded with the demo
     transcript; everything else starts empty. */
  const [timelines, setTimelines] = useState<TimelineState>(() => ({
    s_repo: seedTimelineForRepoWeb(),
    s_api: seedTimelineForApiServer(),
    s_tools: [],
    s_infra: [],
  }));
  /** Per-session "assistant is typing" indicator. Set to true when user
     sends a message; flipped off when the mock assistant reply lands. */
  const [thinking, setThinking] = useState<Record<string, boolean>>({});
  /** Per-daemon "starting a session" indicator — replaces the + button
     icon with a spinner until the new session lands. */
  const [startingDaemon, setStartingDaemon] = useState<string | null>(null);

  // Mobile is single-stack: Home OR Session. Tablet/desktop show both side
  // by side, so `screen` is meaningful only on mobile.
  const isMobile = device === "mobile";
  const showHome = !isMobile || screen === "home";
  const showSession = !isMobile || screen === "session";

  const selectedSession = useMemo(
    () => sessions.find((s) => s.id === selectedSessionId) ?? sessions[0]!,
    [sessions, selectedSessionId],
  );
  const pendingForSelected =
    permission && permission.request.session_id === selectedSession.id
      ? permission
      : null;

  // Decision handler — fakes a 700ms daemon roundtrip then transitions the
  // session row's state to working (allow) or idle (deny) and clears the
  // permission. On allow, also append a "running" tool card to the timeline
  // so the user can see *what* got approved actually start.
  useEffect(() => {
    if (!permission?.submitting) return;
    const decision = permission.submitting;
    const sessionId = permission.request.session_id;
    const tool = permission.request.tool;
    const args = permission.request.args_summary;

    const t = setTimeout(() => {
      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId
            ? {
                ...s,
                state: decision === "allow" ? "working" : "idle",
                activity:
                  decision === "allow"
                    ? "running tool"
                    : "permission denied",
                unread: 0,
              }
            : s,
        ),
      );
      // On allow, append the running tool card. After ~1.6s, "complete" it
      // so the user sees the active → success morph.
      if (decision === "allow") {
        const ts = Date.now();
        const toolId = `t_${ts}`;
        setTimelines((prev) => ({
          ...prev,
          [sessionId]: [
            ...(prev[sessionId] ?? []),
            {
              tag: "tool",
              id: toolId,
              ts,
              chunk: {
                type: EventType.TOOL_CALL_CHUNK,
                toolCallId: toolId,
                toolCallName: tool,
                delta: args,
                timestamp: ts,
              } as ToolCallChunkEvent,
            },
          ],
        }));
        setTimeout(() => {
          setTimelines((prev) => ({
            ...prev,
            [sessionId]: (prev[sessionId] ?? []).map((it) =>
              it.tag === "tool" && it.id === toolId
                ? {
                    ...it,
                    result: {
                      type: EventType.TOOL_CALL_RESULT,
                      messageId: `r_${toolId}`,
                      toolCallId: toolId,
                      content:
                        "removed 142 directories, freed 218 MB",
                      timestamp: Date.now(),
                    } as ToolCallResultEvent,
                  }
                : it,
            ),
          }));
          // Tool finished — bring session back to idle.
          setSessions((prev) =>
            prev.map((s) =>
              s.id === sessionId
                ? { ...s, state: "idle", activity: "idle just now" }
                : s,
            ),
          );
        }, 1800);
      }
      setPermission(null);
    }, 700);
    return () => clearTimeout(t);
  }, [permission]);

  const onDecidePermission = (decision: "allow" | "deny") => {
    setPermission((prev) => (prev ? { ...prev, submitting: decision } : prev));
  };

  const handleSelectSession = (id: string) => {
    setSelectedSessionId(id);
    setScreen("session");
  };

  const handleKillSession = (id: string) => {
    // Mark killing → row dims + Kill button shows spinner. After 600ms,
    // remove from list. The visible "going away" beat reassures the user
    // their tap was received.
    setKilling((prev) => new Set(prev).add(id));
    setTimeout(() => {
      setSessions((prev) => prev.filter((s) => s.id !== id));
      setKilling((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      setKillConfirm(null);
      if (selectedSessionId === id) {
        const remaining = sessions.find(
          (s) => s.id !== id && s.state !== "offline",
        );
        if (remaining) setSelectedSessionId(remaining.id);
        setScreen("home");
      }
    }, 600);
  };

  /** Mock "Send" — append user bubble optimistically, set thinking=true,
      then 1.4s later append assistant bubble + clear thinking. */
  const handleSendChat = (sessionId: string, text: string) => {
    const ts = Date.now();
    const userId = `u_${ts}`;
    const asstId = `a_${ts}`;
    setTimelines((prev) => ({
      ...prev,
      [sessionId]: [
        ...(prev[sessionId] ?? []),
        {
          tag: "agui",
          id: userId,
          ts,
          event: {
            type: EventType.TEXT_MESSAGE_CHUNK,
            messageId: userId,
            role: "user",
            delta: text,
            timestamp: ts,
          } as TextMessageChunkEvent,
        },
      ],
    }));
    setThinking((prev) => ({ ...prev, [sessionId]: true }));
    setTimeout(() => {
      setTimelines((prev) => ({
        ...prev,
        [sessionId]: [
          ...(prev[sessionId] ?? []),
          {
            tag: "agui",
            id: asstId,
            ts: Date.now(),
            event: {
              type: EventType.TEXT_MESSAGE_CHUNK,
              messageId: asstId,
              role: "assistant",
              delta: mockReplyFor(text),
              timestamp: Date.now(),
            } as TextMessageChunkEvent,
          },
        ],
      }));
      setThinking((prev) => ({ ...prev, [sessionId]: false }));
    }, 1400);
  };

  /** Start a fresh session in the given daemon. Show spinner for 1.4s,
     then drop a new working session into the list. */
  const handleStartSession = (daemonId: string, cwd: string) => {
    if (startingDaemon) return;
    setStartingDaemon(daemonId);
    setTimeout(() => {
      const id = `s_new_${Date.now()}`;
      const name = cwd.split("/").filter(Boolean).pop() ?? "new-session";
      setSessions((prev) => [
        ...prev,
        {
          id,
          daemonId,
          name,
          model: "sonnet",
          cwd,
          activity: "starting…",
          state: "working",
          unread: 0,
          tasks: 0,
          lastSeen: "now",
        },
      ]);
      setStartingDaemon(null);
      // Auto-promote to idle 800ms later — the boot beat.
      setTimeout(() => {
        setSessions((prev) =>
          prev.map((s) =>
            s.id === id
              ? { ...s, state: "idle", activity: "ready" }
              : s,
          ),
        );
      }, 800);
    }, 1400);
  };

  return (
    <div className={cn(theme === "dark" && "dark")}>
      <main className="bg-background text-foreground min-h-screen px-4 py-5 md:px-6">
        <div className="mx-auto flex max-w-[1480px] flex-col gap-4">
          <ToolBar
            device={device}
            setDevice={setDevice}
            theme={theme}
            setTheme={setTheme}
            view={view}
            setView={setView}
          />

          {view === "catalog" ? (
            <CardCatalog />
          ) : (
            <DeviceFrame device={device}>
              <AppShell
                device={device}
                connected
                onOpenSettings={() => setSettingsOpen(true)}
                showHome={showHome}
                showSession={showSession}
                home={
                  <HomeScreen
                    sessions={sessions}
                    selectedSessionId={
                      isMobile ? undefined : selectedSession.id
                    }
                    onSelectSession={handleSelectSession}
                    killConfirm={killConfirm}
                    setKillConfirm={setKillConfirm}
                    killing={killing}
                    onKillSession={handleKillSession}
                    startingDaemon={startingDaemon}
                    onStartSession={handleStartSession}
                    pendingPermission={permission?.request}
                    onReviewPermission={() => {
                      if (!permission) return;
                      setSelectedSessionId(permission.request.session_id);
                      setScreen("session");
                    }}
                  />
                }
                session={
                  <SessionPane
                    device={device}
                    session={selectedSession}
                    timeline={timelines[selectedSession.id] ?? []}
                    thinking={!!thinking[selectedSession.id]}
                    pendingPermission={pendingForSelected}
                    onDecidePermission={onDecidePermission}
                    onSendChat={(text) =>
                      handleSendChat(selectedSession.id, text)
                    }
                    onBack={() => setScreen("home")}
                  />
                }
              />
              {settingsOpen && (
                <SettingsDrawer
                  device={device}
                  onClose={() => setSettingsOpen(false)}
                />
              )}
            </DeviceFrame>
          )}
        </div>
      </main>
    </div>
  );
}

/* --------------------------------------------------------------------- */
/* Toolbar (above the device frame)                                      */
/* --------------------------------------------------------------------- */

function ToolBar({
  device,
  setDevice,
  theme,
  setTheme,
  view,
  setView,
}: {
  device: Device;
  setDevice: (d: Device) => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
  view: View;
  setView: (v: View) => void;
}) {
  return (
    <section className="rounded-sheet border-border bg-surface shadow-card border p-3 md:p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="bg-primary-subtle text-primary inline-flex size-9 items-center justify-center rounded-md">
            <ClaudeCodeMark size="sm" />
          </div>
          <div className="min-w-0">
            <p className="text-tertiary-foreground text-[10px] font-semibold uppercase tracking-[0.16em]">
              cc-remote · prototype
            </p>
            <h1 className="text-foreground text-[15px] font-semibold leading-tight">
              {view === "live"
                ? "Live interaction — tap to drive the real surfaces"
                : "Card catalog — every variant, in one place"}
            </h1>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ViewPills view={view} setView={setView} />
          {view === "live" && (
            <DevicePills device={device} setDevice={setDevice} />
          )}
          <Button
            aria-label="Toggle theme"
            onClick={() =>
              setTheme(theme === "light" ? "dark" : "light")
            }
            size="icon"
            variant="secondary"
          >
            {theme === "light" ? (
              <Moon className="size-4" />
            ) : (
              <Sun className="size-4" />
            )}
          </Button>
        </div>
      </div>
    </section>
  );
}

function ViewPills({
  view,
  setView,
}: {
  view: View;
  setView: (v: View) => void;
}) {
  const items: Array<{ id: View; label: string }> = [
    { id: "live", label: "Live" },
    { id: "catalog", label: "Catalog" },
  ];
  return (
    <div
      className="border-border bg-muted inline-flex rounded-full border p-1"
      role="tablist"
      aria-label="View"
    >
      {items.map(({ id, label }) => (
        <button
          key={id}
          role="tab"
          aria-selected={view === id}
          className={cn(
            "inline-flex min-h-9 items-center gap-1.5 rounded-full px-3 text-xs font-semibold cc-transition-state",
            view === id
              ? "bg-primary text-primary-foreground shadow-card"
              : "text-muted-foreground hover:bg-surface hover:text-foreground",
          )}
          onClick={() => setView(id)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function DevicePills({
  device,
  setDevice,
}: {
  device: Device;
  setDevice: (d: Device) => void;
}) {
  return (
    <div
      className="border-border bg-muted inline-flex rounded-full border p-1"
      role="tablist"
    >
      {devices.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          role="tab"
          aria-selected={device === id}
          className={cn(
            "inline-flex min-h-9 items-center gap-1.5 rounded-full px-3 text-xs font-semibold cc-transition-state",
            device === id
              ? "bg-primary text-primary-foreground shadow-card"
              : "text-muted-foreground hover:bg-surface hover:text-foreground",
          )}
          onClick={() => setDevice(id)}
        >
          <Icon className="size-3.5" />
          {label}
        </button>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------------- */
/* Device frame                                                          */
/* --------------------------------------------------------------------- */

function DeviceFrame({
  device,
  children,
}: {
  device: Device;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-x-auto pb-2">
      <div
        className={cn(
          // `transform-gpu` creates a containing block, scoping any
          // `position:fixed` descendants (e.g., SettingsDrawer overlay) to
          // this device frame instead of the full viewport.
          "border-border bg-background shadow-sheet transform-gpu mx-auto overflow-hidden rounded-[28px] border cc-transition-state",
          device === "mobile" && "h-[844px] w-[390px]",
          device === "tablet" && "h-[820px] w-[820px]",
          device === "desktop" && "h-[820px] w-[1280px]",
        )}
      >
        {children}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------- */
/* App shell (header + body layout)                                      */
/* --------------------------------------------------------------------- */

function AppShell({
  device,
  connected,
  home,
  session,
  showHome,
  showSession,
  onOpenSettings,
}: {
  device: Device;
  connected: boolean;
  home: React.ReactNode;
  session: React.ReactNode;
  showHome: boolean;
  showSession: boolean;
  onOpenSettings: () => void;
}) {
  return (
    <div className="bg-background relative flex h-full flex-col">
      <header className="border-border bg-surface flex h-14 shrink-0 items-center justify-between border-b px-4">
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
            <Button size="sm" variant="ghost">
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
          device === "tablet" && "grid grid-cols-[320px_minmax(0,1fr)]",
          device === "desktop" && "grid grid-cols-[72px_400px_minmax(0,1fr)]",
        )}
      >
        {device === "desktop" && <DesktopNav />}
        {device === "mobile" ? (
          <div className="min-h-0 min-w-0 flex-1">
            {showSession ? session : home}
          </div>
        ) : (
          <>
            <div className="min-h-0 min-w-0">{home}</div>
            <div className="min-h-0 min-w-0">{session}</div>
          </>
        )}
      </div>
    </div>
  );
}

function DesktopNav() {
  return (
    <nav className="border-border bg-surface flex flex-col items-center gap-3 border-r px-3 py-4">
      <button
        aria-label="Machines"
        className="text-foreground bg-muted flex size-11 items-center justify-center rounded-md"
      >
        <Smartphone className="size-5" />
      </button>
    </nav>
  );
}

/* --------------------------------------------------------------------- */
/* Home (machines + session list)                                        */
/* --------------------------------------------------------------------- */

function HomeScreen({
  sessions,
  selectedSessionId,
  killConfirm,
  setKillConfirm,
  killing,
  onSelectSession,
  onKillSession,
  startingDaemon,
  onStartSession,
  pendingPermission,
  onReviewPermission,
}: {
  sessions: SessionRecord[];
  selectedSessionId?: string;
  killConfirm: string | null;
  setKillConfirm: (id: string | null) => void;
  killing: Set<string>;
  onSelectSession: (id: string) => void;
  onKillSession: (id: string) => void;
  startingDaemon: string | null;
  onStartSession: (daemonId: string, cwd: string) => void;
  pendingPermission?: PwaPermissionRequest;
  onReviewPermission: () => void;
}) {
  // Group sessions by daemon for the cards; preserve session order.
  const grouped = sessions.reduce<Record<string, SessionRecord[]>>(
    (acc, s) => {
      (acc[s.daemonId] ??= []).push(s);
      return acc;
    },
    {},
  );

  const onlineDaemonIds = ["mbp-m3"];
  const offlineDaemonIds = ["dev-vm-eu"];

  return (
    <section
      className="bg-background h-full overflow-y-auto"
      data-testid="home-screen"
    >
      {pendingPermission && (
        <div className="px-4 pt-4">
          <PermissionMiniCard
            request={pendingPermission}
            onReview={onReviewPermission}
          />
        </div>
      )}

      <div className="px-4 pt-4 pb-2 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Machines</h2>
        <span className="text-muted-foreground text-xs">
          {onlineDaemonIds.length + offlineDaemonIds.length} daemons
        </span>
      </div>

      <div className="px-4 pb-4">
        {onlineDaemonIds.map((id) => (
          <DaemonCard
            key={id}
            daemonId={id}
            hostname={id === "mbp-m3" ? "mbp-m3.local" : id}
            online
            sessions={grouped[id] ?? []}
            selectedSessionId={selectedSessionId}
            onSelectSession={onSelectSession}
            killConfirm={killConfirm}
            setKillConfirm={setKillConfirm}
            killing={killing}
            onKillSession={onKillSession}
            starting={startingDaemon === id}
            onStartSession={onStartSession}
          />
        ))}
        {offlineDaemonIds.map((id) => (
          <DaemonCard
            key={id}
            daemonId={id}
            hostname={id === "dev-vm-eu" ? "dev-vm-eu" : id}
            online={false}
            sessions={grouped[id] ?? []}
            selectedSessionId={selectedSessionId}
            onSelectSession={onSelectSession}
            killConfirm={killConfirm}
            setKillConfirm={setKillConfirm}
            killing={killing}
            onKillSession={onKillSession}
            starting={false}
            onStartSession={onStartSession}
          />
        ))}
      </div>
    </section>
  );
}

function PermissionMiniCard({
  request,
  onReview,
}: {
  request: PwaPermissionRequest;
  onReview: () => void;
}) {
  return (
    <article
      className={cn(
        "rounded-card border-warning/45 bg-warning-subtle/50 p-3 cc-permission-enter",
        "shadow-[0_2px_8px_rgba(217,119,6,0.08)] border",
      )}
      data-testid="home-permission-mini"
    >
      <div className="flex items-start gap-3">
        <span className="bg-warning text-warning-foreground inline-flex size-8 shrink-0 items-center justify-center rounded-md">
          <Plus className="size-4 rotate-45" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold">1 approval waiting</p>
          <p className="text-muted-foreground truncate text-sm">
            {request.daemon_id} · {request.session_id.replace(/^s_/, "")} · {request.tool}
          </p>
          <code className="bg-code text-code-foreground mt-2 block truncate rounded-sm px-2 py-1 font-mono text-xs">
            {request.args_summary}
          </code>
        </div>
        <Button onClick={onReview} size="sm">
          Review
        </Button>
      </div>
    </article>
  );
}

function DaemonCard({
  daemonId,
  hostname,
  online,
  sessions,
  selectedSessionId,
  onSelectSession,
  killConfirm,
  setKillConfirm,
  killing,
  onKillSession,
  starting,
  onStartSession,
}: {
  daemonId: string;
  hostname: string;
  online: boolean;
  sessions: SessionRecord[];
  selectedSessionId?: string;
  onSelectSession: (id: string) => void;
  killConfirm: string | null;
  setKillConfirm: (id: string | null) => void;
  killing: Set<string>;
  onKillSession: (id: string) => void;
  starting: boolean;
  onStartSession: (daemonId: string, cwd: string) => void;
}) {
  const [cwd, setCwd] = useState("");
  return (
    <article
      className={cn(
        "rounded-card border-border bg-surface shadow-card mt-3 border p-3",
        !online && "opacity-75",
      )}
      data-testid={`machine-card-${daemonId}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate font-semibold">{hostname}</h3>
          <p className="text-muted-foreground text-sm">
            {online ? "Online — last seen now" : "Offline — last seen 12m ago"}
          </p>
        </div>
        {online ? (
          <span className="bg-muted text-muted-foreground rounded-full px-2 py-1 text-xs">
            {sessions.length} ses
          </span>
        ) : (
          <StatusChip label="Offline" tone="offline" />
        )}
      </div>

      {online && (
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = cwd.trim();
            if (!trimmed || starting) return;
            onStartSession(daemonId, trimmed);
            setCwd("");
          }}
        >
          <input
            aria-label={`Working directory for ${hostname}`}
            className="border-border bg-muted text-foreground focus:border-ring focus:ring-ring/30 disabled:text-disabled h-11 min-w-0 flex-1 rounded-md border px-3 font-mono text-sm outline-none focus:ring-2 cc-transition-state"
            disabled={starting}
            onChange={(e) => setCwd(e.target.value)}
            placeholder={starting ? "Starting session…" : "/path/to/project"}
            value={cwd}
          />
          <Button
            aria-label="Start session"
            disabled={!cwd.trim() || starting}
            size="icon"
            type="submit"
          >
            {starting ? <Spinner /> : <Plus className="size-4" />}
          </Button>
        </form>
      )}

      {sessions.length > 0 && (
        <div className="mt-3 grid gap-2">
          {sessions.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              selected={selectedSessionId === s.id}
              onSelect={() => onSelectSession(s.id)}
              killConfirm={killConfirm}
              setKillConfirm={setKillConfirm}
              killing={killing.has(s.id)}
              onKillSession={onKillSession}
            />
          ))}
        </div>
      )}
    </article>
  );
}

function SessionRow({
  session,
  selected,
  onSelect,
  killConfirm,
  setKillConfirm,
  killing,
  onKillSession,
}: {
  session: SessionRecord;
  selected?: boolean;
  onSelect: () => void;
  killConfirm: string | null;
  setKillConfirm: (id: string | null) => void;
  killing: boolean;
  onKillSession: (id: string) => void;
}) {
  const confirming = killConfirm === session.id;
  const offline = session.state === "offline";
  return (
    <div
      className={cn(
        // Nested row inside the daemon card — no shadow, soft tinted bg so
        // the outer card stays the elevation anchor. Borders + tints carry
        // state (waiting > working > idle > offline). Design.md §11 second-
        // tier hierarchy: state should be readable before the eye lands.
        "rounded-md border bg-muted/40 cc-transition-state",
        session.state === "waiting" &&
          "border-warning/45 bg-warning-subtle/50 border-l-2 border-l-warning",
        session.state === "working" && "border-primary/25 bg-primary-subtle/30",
        session.state === "idle" && "border-border",
        offline && "border-border bg-muted/30 opacity-70",
        selected && "ring-1 ring-ring/40",
        killing && "pointer-events-none opacity-50",
      )}
      data-session-id={session.id}
    >
      <button
        className="flex min-h-[44px] w-full items-start gap-3 px-3 py-3 text-left"
        onClick={onSelect}
        disabled={offline || killing}
      >
        <StatusIcon state={session.state} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center justify-between gap-2">
            <span className="truncate font-semibold">{session.name}</span>
            <StatusChip
              label={stateLabel(session.state)}
              tone={session.state}
            />
          </span>
          <span className="text-tertiary-foreground mt-1 block truncate font-mono text-[13px]">
            {session.model} · {session.cwd}
          </span>
          <span className="text-tertiary-foreground mt-1 block text-xs">
            unread {session.unread} · tasks {session.tasks} · {session.activity}
          </span>
        </span>
      </button>

      {/* Inline kill action / confirm.  We render both layers and cross-fade
          via opacity so the row never reflows on click — the eye stays on
          the same pixel position. */}
      <div className="relative mx-3 mb-2 h-9">
        <div
          className={cn(
            "absolute inset-0 flex justify-end cc-transition-state",
            confirming || killing
              ? "pointer-events-none opacity-0"
              : "opacity-100",
          )}
        >
          <Button
            aria-label={`Kill session ${session.name}`}
            onClick={() => setKillConfirm(session.id)}
            size="sm"
            variant="ghost"
            disabled={offline}
          >
            <Trash2 className="text-danger size-4" />
          </Button>
        </div>
        <div
          className={cn(
            "absolute inset-0 flex items-center justify-between gap-2 rounded-md bg-danger-subtle px-2 cc-transition-state",
            confirming ? "opacity-100" : "pointer-events-none opacity-0",
          )}
        >
          <span className="text-danger text-xs font-semibold">
            {killing ? "Killing…" : "Kill session?"}
          </span>
          <span className="flex gap-2">
            <Button
              onClick={() => setKillConfirm(null)}
              size="sm"
              variant="secondary"
              disabled={killing}
            >
              Cancel
            </Button>
            <Button
              onClick={() => onKillSession(session.id)}
              size="sm"
              variant="danger"
              disabled={killing}
            >
              {killing ? <Spinner /> : "Kill"}
            </Button>
          </span>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------- */
/* Session pane                                                          */
/* --------------------------------------------------------------------- */

function SessionPane({
  device,
  session,
  timeline,
  thinking,
  pendingPermission,
  onDecidePermission,
  onSendChat,
  onBack,
}: {
  device: Device;
  session: SessionRecord;
  timeline: RenderItem[];
  thinking: boolean;
  pendingPermission: PermissionState | null;
  onDecidePermission: (decision: "allow" | "deny") => void;
  onSendChat: (text: string) => void;
  onBack: () => void;
}) {
  const blocked = !!pendingPermission;
  const offline = session.state === "offline";

  return (
    <section
      className="bg-surface border-border flex h-full min-h-0 min-w-0 flex-col border-l"
      data-testid="session-view"
    >
      <header className="border-border flex items-center justify-between gap-2 border-b p-3">
        <div className="flex min-w-0 items-center gap-2">
          {device === "mobile" && (
            <Button
              aria-label="Back to home"
              onClick={onBack}
              size="icon"
              variant="ghost"
            >
              <ArrowLeft className="size-4" />
            </Button>
          )}
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold">{session.name}</h2>
            <p className="text-tertiary-foreground truncate font-mono text-[13px]">
              {session.cwd} · {session.model}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <StatusChip
            label={stateLabel(session.state)}
            tone={session.state}
          />
          <Button aria-label="More" size="icon" variant="ghost">
            <MoreHorizontal className="size-4" />
          </Button>
        </div>
      </header>

      <div className="flex flex-1 flex-col overflow-hidden">
        {pendingPermission && (
          <div className="px-3 pt-3">
            <InlinePermissionCard
              request={pendingPermission.request}
              pendingReply={
                pendingPermission.submitting
                  ? {
                      id: "demo-pending",
                      kind: "permission_reply",
                      daemon_id: pendingPermission.request.daemon_id,
                      session_id: pendingPermission.request.session_id,
                      started_at: Date.now(),
                      status: "pending",
                    }
                  : undefined
              }
              onDecide={onDecidePermission}
            />
          </div>
        )}
        <div className="flex-1 overflow-y-auto px-3 py-3">
          <SessionTimeline items={timeline} thinking={thinking} />
        </div>
      </div>

      <Composer
        blocked={blocked}
        offline={offline}
        onSend={onSendChat}
      />
    </section>
  );
}

function Composer({
  blocked,
  offline,
  onSend,
}: {
  blocked: boolean;
  offline: boolean;
  onSend: (text: string) => void;
}) {
  const [draft, setDraft] = useState("");
  // The `sending` window is the optimistic-send beat: composer disables for
  // ~280ms so the user sees the click landed before the input clears. Even
  // though our mock onSend is synchronous, this matches the real
  // `pendingChatSend` rhythm where the daemon ack takes a real moment.
  const [sending, setSending] = useState(false);
  const [slashDismissed, setSlashDismissed] = useState(false);

  const placeholder = offline
    ? "Session offline"
    : blocked
      ? "Waiting for permission"
      : sending
        ? "Sending…"
        : "Message Claude…  (type / for commands)";
  const disabled = blocked || offline || sending;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed || disabled) return;
    setSending(true);
    onSend(trimmed);
    setDraft("");
    setSlashDismissed(false);
    // Re-enable shortly after — gives the eye time to register the spinner.
    setTimeout(() => setSending(false), 280);
  };

  const handleSelectSlash = (entry: SlashEntry) => {
    // Filling the name + space matches CC TUI: user picks the command, then
    // continues to fill arguments inline (or just hits Enter to invoke the
    // bare command).
    setDraft(entry.name + " ");
  };

  // Re-show the menu whenever the draft starts with "/" again after a
  // dismiss. SlashMenu itself returns null when filtered is empty so we
  // don't need to track visibility manually.
  const menuDraft = slashDismissed ? "" : draft;

  return (
    <div className="border-border bg-surface border-t p-3 pb-[calc(12px+env(safe-area-inset-bottom))]">
      <form className="relative flex gap-2" onSubmit={handleSubmit}>
        <SlashMenu
          entries={mockSlashEntries}
          draft={menuDraft}
          onSelect={handleSelectSlash}
          onDismiss={() => setSlashDismissed(true)}
        />
        <input
          className="border-border bg-muted focus:border-ring focus:ring-ring/30 disabled:text-disabled h-11 min-w-0 flex-1 rounded-md border px-3 text-base outline-none focus:ring-2 cc-transition-state"
          disabled={disabled}
          onChange={(e) => {
            setDraft(e.target.value);
            // User actively typing again — bring the menu back if they had
            // dismissed it.
            if (slashDismissed) setSlashDismissed(false);
          }}
          placeholder={placeholder}
          value={draft}
        />
        <Button
          aria-label="Send"
          disabled={disabled || !draft.trim()}
          size="icon"
          type="submit"
        >
          {sending ? <Spinner /> : <Send className="size-4" />}
        </Button>
      </form>
    </div>
  );
}

/* --------------------------------------------------------------------- */
/* Session timeline (real cards, mocked events)                          */
/* --------------------------------------------------------------------- */

function SessionTimeline({
  items,
  thinking,
}: {
  items: RenderItem[];
  thinking: boolean;
}) {
  // Auto-scroll so the latest message + typing dots stay in view.
  const tailRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    tailRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [items.length, thinking]);

  if (items.length === 0 && !thinking) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center text-sm italic">
        No events yet — send a message to start.
      </div>
    );
  }

  // Group consecutive tool calls so a streak of Bash/Edit/… renders as a
  // single collapsed strip ("Ran 4 commands · 23s") instead of N stacked
  // cards. Chat / permission events pass through untouched.
  const groups = groupTimelineItems(items);

  return (
    <div className="flex flex-col gap-3 pb-3">
      {groups.map((g) => renderTimelineGroup(g))}
      {thinking && <ThinkingRow />}
      <div ref={tailRef} />
    </div>
  );
}

/**
 * Inline "assistant is typing" beat. Renders just inside the timeline's
 * left rail so the avatar sits in the same column as a real assistant
 * bubble's marker. We deliberately keep the chrome quiet — italic text +
 * subtle dot trail — instead of a card. A boxy "AI is generating…"
 * widget reads as a system notification; this should read as Claude
 * actually composing.
 */
function ThinkingRow() {
  return (
    <div
      className="flex items-center gap-2.5 cc-enter"
      data-testid="thinking-row"
    >
      <ClaudeAvatar size="sm" />
      <span className="text-muted-foreground text-[13px] italic">
        Claude is thinking
      </span>
      <TypingIndicator className="text-muted-foreground" />
    </div>
  );
}

/* Initial timeline seeds — mock the conversation that "got us here". */

function seedTimelineForRepoWeb(): RenderItem[] {
  const t = (mins: number) => new Date(2026, 4, 21, 10, mins).getTime();
  return [
    {
      tag: "agui",
      id: "demo-user-1",
      ts: t(20),
      event: {
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "demo-user-1",
        role: "user",
        delta:
          "Add a **password reset** flow using email tokens.\n\n" +
          "Make sure to:\n\n" +
          "- store hashed tokens (never plaintext)\n" +
          "- expire after `15m`\n" +
          "- rate-limit `/auth/reset` to 5/min/IP",
        timestamp: t(20),
      } as TextMessageChunkEvent,
    },
    {
      tag: "agui",
      id: "demo-asst-1",
      ts: t(21),
      event: {
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "demo-asst-1",
        role: "assistant",
        delta:
          "## Plan\n\n" +
          "I'll add the reset flow in three steps:\n\n" +
          "1. New route `POST /auth/reset` issues a token\n" +
          "2. Token stored as `bcrypt`-hashed row in `password_resets`\n" +
          "3. `POST /auth/reset/confirm` consumes the token\n\n" +
          "```ts\n" +
          "const token = randomBytes(32).toString('hex');\n" +
          "await db.passwordResets.insert({ user_id, token_hash: hash(token), expires_at });\n" +
          "```\n\n" +
          "Starting with the schema migration first.",
        timestamp: t(21),
      } as TextMessageChunkEvent,
    },
    {
      tag: "tool",
      id: "demo-tool-bash",
      ts: t(22),
      chunk: {
        type: EventType.TOOL_CALL_CHUNK,
        toolCallId: "tc_bash_demo",
        toolCallName: "Bash",
        delta: "pnpm test auth",
        timestamp: t(22),
      } as ToolCallChunkEvent,
      result: {
        type: EventType.TOOL_CALL_RESULT,
        messageId: "tr_bash_demo",
        toolCallId: "tc_bash_demo",
        content: "All 42 tests passed",
        timestamp: t(22),
      } as ToolCallResultEvent,
    },
    {
      tag: "tool",
      id: "demo-tool-edit",
      ts: t(23),
      chunk: {
        type: EventType.TOOL_CALL_CHUNK,
        toolCallId: "tc_edit_demo",
        toolCallName: "Edit",
        delta:
          'file_path: "src/routes/auth/reset.ts"\nold_string: "// TODO"\nnew_string: "router.post(\'/reset\', resetHandler);"',
        timestamp: t(23),
      } as ToolCallChunkEvent,
      result: {
        type: EventType.TOOL_CALL_RESULT,
        messageId: "tr_edit_demo",
        toolCallId: "tc_edit_demo",
        content:
          "Applied edit to src/routes/auth/reset.ts\n" +
          "  Lines: 45-68\n" +
          "  +24 −6\n" +
          "Saved.\n",
        timestamp: t(23),
      } as ToolCallResultEvent,
    },
  ];
}

/* The api-server session has a *running* tool — useful for showing the
   active tool card chrome (left primary border + breathing dot) before
   the result lands. */
function seedTimelineForApiServer(): RenderItem[] {
  const t = (mins: number) => new Date(2026, 4, 21, 10, mins).getTime();
  return [
    {
      tag: "agui",
      id: "api-user-1",
      ts: t(40),
      event: {
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "api-user-1",
        role: "user",
        delta: "Run the migration and check that the rate limiter holds.",
        timestamp: t(40),
      } as TextMessageChunkEvent,
    },
    {
      tag: "agui",
      id: "api-asst-1",
      ts: t(41),
      event: {
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "api-asst-1",
        role: "assistant",
        delta:
          "Running the migration first, then I'll hammer `/auth/reset` with the rate-limit smoke test.",
        timestamp: t(41),
      } as TextMessageChunkEvent,
    },
    {
      // No `result` → renders as Active (running) with the breathing dot.
      tag: "tool",
      id: "api-tool-running",
      ts: t(42),
      chunk: {
        type: EventType.TOOL_CALL_CHUNK,
        toolCallId: "api_running",
        toolCallName: "Bash",
        delta: "pnpm migrate && pnpm test:rate-limit",
        timestamp: t(42),
      } as ToolCallChunkEvent,
    },
  ];
}

/* Cheap reply generator — picks a small canned variant based on the
   user's keywords so the demo conversation stays coherent. Slash
   commands also short-circuit to a canned shape so /help, /cost, /clear
   feel real. */
function mockReplyFor(input: string): string {
  if (input.startsWith("/")) {
    const head = input.split(/\s+/, 1)[0] ?? "";
    switch (head) {
      case "/clear":
        return "Conversation cleared. Context window freed.";
      case "/help":
        return "Usage: type a message, or `/` to invoke a slash command. See available commands by typing `/`.";
      case "/cost":
        return "**Session usage**\n\n- Input tokens: 24,318\n- Output tokens: 8,142\n- Estimated cost: $0.34";
      case "/compact":
        return "Compacting conversation… reduced context by ~62%.";
      case "/brainstorming":
        return "Let's explore the intent first. What outcome are you trying to drive — and for whom?";
      case "/commit":
        return "Drafted commit:\n\n```\nfeat(auth): add password reset flow\n```\n\nRun `git commit` to apply.";
      case "/code-review":
        return "Reviewing the diff now — I'll flag correctness bugs and reuse opportunities.";
      case "/run-tests":
        return "Running the project test suite — I'll surface any failures inline.";
      case "/deploy-staging":
        return "Deploying current branch to staging. This usually takes ~3 minutes.";
      case "/standup":
        return "**Yesterday**\n\n- Wrapped the password-reset migration\n- Reviewed Henry's PR #482\n- Paired on the rate-limiter spike";
      default:
        return `Running \`${head}\`…`;
    }
  }
  const lower = input.toLowerCase();
  if (lower.includes("test")) {
    return "Running the relevant test suite now — I'll surface the failures inline.";
  }
  if (lower.includes("fix") || lower.includes("bug")) {
    return "I'll inspect the failure, isolate the root cause, and patch it.";
  }
  if (lower.includes("?")) {
    return "Good question — let me check the code and come back with a concrete answer.";
  }
  return "Got it. I'll start working on that and stream updates as I go.";
}

/* --------------------------------------------------------------------- */
/* Settings drawer                                                       */
/* --------------------------------------------------------------------- */

function SettingsDrawer({
  device,
  onClose,
}: {
  device: Device;
  onClose: () => void;
}) {
  return (
    <div
      className="bg-overlay absolute inset-0 z-40"
      onClick={onClose}
    >
      <aside
        className={cn(
          "bg-elevated shadow-sheet ml-auto h-full overflow-y-auto cc-enter",
          device === "mobile" ? "w-full p-4" : "w-[410px] p-5",
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Settings</h2>
          <Button
            aria-label="Close settings"
            onClick={onClose}
            size="icon"
            variant="ghost"
          >
            <X className="size-4" />
          </Button>
        </div>
        <div className="mt-5 space-y-5">
          <SettingsSection title="Account">
            <p className="text-muted-foreground text-sm">
              gramiria2026@outlook.com
            </p>
            <Button className="mt-3" size="sm" variant="danger">
              Sign out
            </Button>
          </SettingsSection>
          <SettingsSection title="Paired devices">
            <DeviceCard name="mbp-m3.local" status="Online" online />
            <DeviceCard name="dev-vm-eu" status="Offline" online={false} />
          </SettingsSection>
          <SettingsSection title="Pair new daemon">
            <div className="rounded-card border-border bg-muted border p-4 text-center">
              <p className="text-muted-foreground text-sm">Pairing code</p>
              <p className="mt-3 font-mono text-2xl font-semibold">
                4825-913P
              </p>
              <p className="text-tertiary-foreground mt-2 text-xs">
                Expires in 10:00
              </p>
              <Button className="mt-3" size="sm" variant="secondary">
                <Copy className="size-4" />
                Copy code
              </Button>
            </div>
          </SettingsSection>
          <SettingsSection title="Notifications">
            <div className="border-border bg-surface flex items-center justify-between rounded-md border px-3 py-2">
              <span className="text-sm">Permission alerts</span>
              <span className="bg-success-subtle text-success rounded-full px-2 py-0.5 text-xs font-semibold">
                On
              </span>
            </div>
          </SettingsSection>
          <SettingsSection title="Appearance">
            <div className="grid grid-cols-3 gap-2">
              {(["System", "Light", "Dark"] as const).map((item, idx) => (
                <Button
                  key={item}
                  size="sm"
                  variant={idx === 0 ? "default" : "secondary"}
                >
                  {item}
                </Button>
              ))}
            </div>
          </SettingsSection>
        </div>
      </aside>
    </div>
  );
}

function SettingsSection({
  children,
  title,
}: {
  children: React.ReactNode;
  title: string;
}) {
  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function DeviceCard({
  name,
  status,
  online,
}: {
  name: string;
  status: string;
  online: boolean;
}) {
  return (
    <div className="rounded-card border-border bg-surface shadow-card mb-2 border p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="font-semibold">{name}</p>
          <p className="text-tertiary-foreground text-xs">paired May 20</p>
        </div>
        <StatusChip
          label={status}
          tone={online ? "online" : "offline"}
        />
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------- */
/* Card catalog — every variant in one scrollable view                   */
/* --------------------------------------------------------------------- */

/**
 * Reference for designers + reviewers. Groups all card surfaces by their
 * elevation level (the rule we landed in pass 11):
 *
 *   L0 sheet  — drawer / modal / popover
 *   L1 card   — daemon, permission, settings device, tool group, chat bubble
 *   L2 row    — nested rows inside a card (no shadow, soft tinted bg)
 *   L3 inline — chips, kbds, badges
 *
 * The page is intentionally NOT inside a device frame: it's a documentation
 * surface, not an app screen. Each tile is labeled so reviewers can compare
 * variants side-by-side, both light and dark via the toolbar theme toggle.
 */
function CardCatalog() {
  const ts = new Date(2026, 4, 21, 10, 21).getTime();

  const sampleSession: SessionRecord = {
    id: "demo",
    daemonId: "demo",
    name: "repo-web",
    model: "sonnet",
    cwd: "/Users/me/repo-web",
    activity: "permission needed",
    state: "waiting",
    unread: 2,
    tasks: 7,
    lastSeen: "now",
  };

  const samplePermissionRequest: PwaPermissionRequest = {
    type: "permission_request",
    daemon_id: "mbp-m3",
    session_id: "s_repo",
    request_id: "req_a3f8b9d2",
    tool: "Bash",
    args_summary: "rm -rf node_modules",
    expires_at: 0,
  };

  return (
    <div className="bg-background rounded-sheet border-border shadow-card mx-auto w-full max-w-[1100px] border p-6 md:p-8">
      <CatalogHeader />

      <CatalogSection
        level="L1"
        title="Surface cards"
        note="Anchored at one shadow level. White surface, 14px radius, full border. The eye should land on these first."
      >
        <CatalogTile label="Daemon card · online">
          <DaemonCard
            daemonId="catalog-online"
            hostname="mbp-m3.local"
            online
            sessions={[sampleSession]}
            selectedSessionId={undefined}
            onSelectSession={() => {}}
            killConfirm={null}
            setKillConfirm={() => {}}
            killing={new Set()}
            onKillSession={() => {}}
            starting={false}
            onStartSession={() => {}}
          />
        </CatalogTile>
        <CatalogTile label="Daemon card · offline">
          <DaemonCard
            daemonId="catalog-offline"
            hostname="dev-vm-eu"
            online={false}
            sessions={[]}
            selectedSessionId={undefined}
            onSelectSession={() => {}}
            killConfirm={null}
            setKillConfirm={() => {}}
            killing={new Set()}
            onKillSession={() => {}}
            starting={false}
            onStartSession={() => {}}
          />
        </CatalogTile>
        <CatalogTile label="Permission · home mini-card">
          <PermissionMiniCard
            request={samplePermissionRequest}
            onReview={() => {}}
          />
        </CatalogTile>
        <CatalogTile label="Permission · inline card">
          <InlinePermissionCard
            request={samplePermissionRequest}
            onDecide={() => {}}
          />
        </CatalogTile>
        <CatalogTile label="Permission · queue 1 of 3">
          <InlinePermissionCard
            request={{
              ...samplePermissionRequest,
              tool: "Bash",
              args_summary: "git reset --hard origin/main",
            }}
            queue={{ position: 1, total: 3 }}
            onDecide={() => {}}
          />
        </CatalogTile>
        <CatalogTile label="Permission · pending decision">
          <InlinePermissionCard
            request={samplePermissionRequest}
            pendingReply={{
              id: "x",
              kind: "permission_reply",
              daemon_id: "d",
              session_id: "s",
              started_at: 0,
              status: "pending",
              label: "allow",
            }}
            onDecide={() => {}}
          />
        </CatalogTile>
        <CatalogTile label="Permission · timed out">
          <InlinePermissionCard
            request={samplePermissionRequest}
            pendingReply={{
              id: "x",
              kind: "permission_reply",
              daemon_id: "d",
              session_id: "s",
              started_at: 0,
              status: "timed_out",
              label: "allow",
            }}
            onDecide={() => {}}
          />
        </CatalogTile>
        <CatalogTile label="Settings · device card">
          <DeviceCard name="mbp-m3.local" status="Online" online />
        </CatalogTile>
      </CatalogSection>

      <CatalogSection
        level="L1"
        title="Conversation cards"
        note="Chat bubbles + tool groups — the heart of the session view."
      >
        <CatalogTile label="Assistant bubble · markdown">
          {renderTimelineGroup({
            kind: "single",
            item: {
              tag: "agui",
              id: "cat-asst",
              ts,
              event: {
                type: EventType.TEXT_MESSAGE_CHUNK,
                messageId: "cat-asst",
                role: "assistant",
                delta:
                  "Here's the **plan**:\n\n" +
                  "1. Issue a hashed token via `/auth/reset`\n" +
                  "2. Store with `expires_at` 15m out\n" +
                  "3. Confirm endpoint consumes it",
                timestamp: ts,
              } as TextMessageChunkEvent,
            },
          })}
        </CatalogTile>
        <CatalogTile label="User bubble">
          {renderTimelineGroup({
            kind: "single",
            item: {
              tag: "agui",
              id: "cat-user",
              ts,
              event: {
                type: EventType.TEXT_MESSAGE_CHUNK,
                messageId: "cat-user",
                role: "user",
                delta: "Add a password reset flow using email tokens.",
                timestamp: ts,
              } as TextMessageChunkEvent,
            },
          })}
        </CatalogTile>
        <CatalogTile label="Tool group · running">
          {renderTimelineGroup({
            kind: "tool-group",
            id: "cat-tg-running",
            items: [
              {
                tag: "tool",
                id: "cat-tg-running-1",
                ts,
                chunk: {
                  type: EventType.TOOL_CALL_CHUNK,
                  toolCallId: "tc",
                  toolCallName: "Bash",
                  delta: "pnpm migrate && pnpm test:rate-limit",
                  timestamp: ts,
                } as ToolCallChunkEvent,
              },
            ],
          })}
        </CatalogTile>
        <CatalogTile label="Tool group · single success">
          {renderTimelineGroup({
            kind: "tool-group",
            id: "cat-tg-1",
            items: [
              {
                tag: "tool",
                id: "cat-tg-1-1",
                ts,
                chunk: {
                  type: EventType.TOOL_CALL_CHUNK,
                  toolCallId: "tc",
                  toolCallName: "Bash",
                  delta: "pnpm test auth",
                  timestamp: ts,
                } as ToolCallChunkEvent,
                result: {
                  type: EventType.TOOL_CALL_RESULT,
                  messageId: "tr",
                  toolCallId: "tc",
                  content: "All 42 tests passed",
                  timestamp: ts + 8000,
                } as ToolCallResultEvent,
              },
            ],
          })}
        </CatalogTile>
        <CatalogTile label="Tool group · ran 4 commands">
          {renderTimelineGroup({
            kind: "tool-group",
            id: "cat-tg-many",
            items: [
              makeMockToolItem("cat-tg-many-1", "Bash", "pnpm test auth", "All 42 tests passed", ts),
              makeMockToolItem(
                "cat-tg-many-2",
                "Edit",
                'file_path: "src/auth/reset.ts"\nold_string: "// TODO"\nnew_string: "router.post(\'/reset\', resetHandler);"',
                "Applied edit to src/auth/reset.ts\n  +24 −6",
                ts + 5000,
              ),
              makeMockToolItem("cat-tg-many-3", "Read", 'file_path: "src/lib/token.ts"', "export const TTL_MS = 15 * 60 * 1000;", ts + 14000),
              makeMockToolItem("cat-tg-many-4", "Bash", "pnpm typecheck", "OK", ts + 23000),
            ],
          })}
        </CatalogTile>
        <CatalogTile label="Tool group · with failure">
          {renderTimelineGroup({
            kind: "tool-group",
            id: "cat-tg-fail",
            items: [
              makeMockToolItem("cat-tg-fail-1", "Bash", "pnpm test auth", "All 42 tests passed", ts),
              {
                tag: "tool",
                id: "cat-tg-fail-2",
                ts: ts + 5000,
                chunk: {
                  type: EventType.TOOL_CALL_CHUNK,
                  toolCallId: "tc-fail",
                  toolCallName: "Bash",
                  delta: "rm -rf node_modules",
                  timestamp: ts + 5000,
                } as ToolCallChunkEvent,
                result: {
                  type: EventType.TOOL_CALL_RESULT,
                  messageId: "tr-fail",
                  toolCallId: "tc-fail",
                  content: "Permission denied: node_modules\nexit code 1",
                  timestamp: ts + 5500,
                  rawEvent: { is_error: true },
                } as ToolCallResultEvent,
              },
            ],
          })}
        </CatalogTile>
      </CatalogSection>

      <CatalogSection
        level="L2"
        title="Nested rows"
        note="Live inside a card — no shadow, soft muted background, state via tint + border. Should feel embedded, not stacked."
      >
        <CatalogTile label="Session row · waiting">
          <SessionRow
            session={{ ...sampleSession, state: "waiting", activity: "permission needed" }}
            selected={false}
            onSelect={() => {}}
            killConfirm={null}
            setKillConfirm={() => {}}
            killing={false}
            onKillSession={() => {}}
          />
        </CatalogTile>
        <CatalogTile label="Session row · working">
          <SessionRow
            session={{ ...sampleSession, id: "w", name: "api-server", state: "working", activity: "running tool" }}
            selected={false}
            onSelect={() => {}}
            killConfirm={null}
            setKillConfirm={() => {}}
            killing={false}
            onKillSession={() => {}}
          />
        </CatalogTile>
        <CatalogTile label="Session row · idle · selected">
          <SessionRow
            session={{ ...sampleSession, id: "i", name: "cli-tools", state: "idle", activity: "idle 8m" }}
            selected
            onSelect={() => {}}
            killConfirm={null}
            setKillConfirm={() => {}}
            killing={false}
            onKillSession={() => {}}
          />
        </CatalogTile>
        <CatalogTile label="Session row · offline">
          <SessionRow
            session={{ ...sampleSession, id: "o", name: "infra", state: "offline", activity: "paused" }}
            selected={false}
            onSelect={() => {}}
            killConfirm={null}
            setKillConfirm={() => {}}
            killing={false}
            onKillSession={() => {}}
          />
        </CatalogTile>
        <CatalogTile label="Session row · kill confirm">
          <SessionRow
            session={{ ...sampleSession, id: "k", name: "stuck-job", state: "working", activity: "stuck 2m" }}
            selected={false}
            onSelect={() => {}}
            killConfirm={"k"}
            setKillConfirm={() => {}}
            killing={false}
            onKillSession={() => {}}
          />
        </CatalogTile>
        <CatalogTile label="Session row · killing in progress">
          <SessionRow
            session={{ ...sampleSession, id: "kp", name: "stuck-job", state: "working", activity: "stuck 2m" }}
            selected={false}
            onSelect={() => {}}
            killConfirm={"kp"}
            setKillConfirm={() => {}}
            killing
            onKillSession={() => {}}
          />
        </CatalogTile>
      </CatalogSection>

      <CatalogSection
        level="L3"
        title="Inline chips & badges"
        note="The smallest pieces — status pills, source labels, kbd hints. Always paired with text."
      >
        <CatalogTile label="StatusChip · all tones" wide>
          <div className="flex flex-wrap gap-2">
            <StatusChip label="Online" tone="online" />
            <StatusChip label="Waiting" tone="waiting" />
            <StatusChip label="Working" tone="working" />
            <StatusChip label="Idle" tone="idle" />
            <StatusChip label="Offline" tone="offline" />
            <StatusChip label="Error" tone="error" />
          </div>
        </CatalogTile>
        <CatalogTile label="SlashMenu source chips" wide>
          <div className="flex flex-wrap gap-2">
            <SourceChip kind="builtin" />
            <SourceChip kind="user" />
            <SourceChip kind="project" />
            <SourceChip kind="skill" />
          </div>
        </CatalogTile>
        <CatalogTile label="Tool status chips" wide>
          <div className="flex flex-wrap gap-2">
            <ToolStatusChip kind="success" />
            <ToolStatusChip kind="failure" />
            <ToolStatusChip kind="active" />
          </div>
        </CatalogTile>
      </CatalogSection>

      <CatalogSection
        level="L0"
        title="Sheets & overlays"
        note="Whole-surface elements — drawer, modal, popover. Cast the strongest shadow because they sit on top."
      >
        <CatalogTile label="Settings drawer (excerpt)" wide>
          <div className="rounded-card border-border bg-elevated shadow-sheet border p-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold">Settings</h3>
              <span className="text-tertiary-foreground text-xs">L0 sheet</span>
            </div>
            <div className="mt-4 space-y-3">
              <DeviceCard name="mbp-m3.local" status="Online" online />
              <DeviceCard name="dev-vm-eu" status="Offline" online={false} />
            </div>
          </div>
        </CatalogTile>
      </CatalogSection>
    </div>
  );
}

function CatalogHeader() {
  const items: Array<{ level: string; what: string }> = [
    { level: "L0", what: "drawer · modal · popover" },
    { level: "L1", what: "daemon · permission · chat · tool group" },
    { level: "L2", what: "session row · tool row" },
    { level: "L3", what: "chip · badge · kbd" },
  ];
  return (
    <header className="border-border mb-6 border-b pb-5">
      <p className="text-tertiary-foreground text-[10px] font-semibold uppercase tracking-[0.16em]">
        cc-remote · card system
      </p>
      <h2 className="text-foreground mt-1 text-[22px] font-semibold leading-tight">
        Every card variant, ranked by elevation
      </h2>
      <p className="text-muted-foreground mt-2 max-w-2xl text-[13px] leading-relaxed">
        Four levels keep the surface readable: outer shells anchor the eye,
        nested rows recede, inline chips ride along with text. Toggle the
        theme to inspect each variant in light and dark.
      </p>
      <ul className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-4">
        {items.map((item) => (
          <li key={item.level} className="flex items-baseline gap-2 text-[12px]">
            <span className="text-primary font-mono font-semibold">
              {item.level}
            </span>
            <span className="text-tertiary-foreground">{item.what}</span>
          </li>
        ))}
      </ul>
    </header>
  );
}

function CatalogSection({
  level,
  title,
  note,
  children,
}: {
  level: "L0" | "L1" | "L2" | "L3";
  title: string;
  note: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-10 last:mb-0">
      <div className="mb-4 flex items-baseline gap-3">
        <span className="text-primary bg-primary-subtle inline-flex h-5 items-center rounded-full px-2 font-mono text-[11px] font-semibold">
          {level}
        </span>
        <h3 className="text-foreground text-[15px] font-semibold">{title}</h3>
      </div>
      <p className="text-muted-foreground mb-5 max-w-2xl text-[13px] leading-relaxed">
        {note}
      </p>
      <div className="grid gap-5 md:grid-cols-2">{children}</div>
    </section>
  );
}

function CatalogTile({
  children,
  label,
  wide,
}: {
  children: React.ReactNode;
  label: string;
  wide?: boolean;
}) {
  return (
    <figure
      className={cn(
        "border-border bg-muted/40 rounded-card border p-4",
        wide && "md:col-span-2",
      )}
    >
      <figcaption className="text-tertiary-foreground mb-3 text-[11px] font-semibold uppercase tracking-[0.12em]">
        {label}
      </figcaption>
      <div className="bg-background rounded-md p-4">{children}</div>
    </figure>
  );
}

function SourceChip({
  kind,
}: {
  kind: "builtin" | "user" | "project" | "skill";
}) {
  const label = kind === "builtin" ? "built-in" : kind;
  return (
    <span
      className={cn(
        "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
        kind === "builtin" &&
          "border-border bg-muted text-muted-foreground",
        kind === "user" &&
          "border-primary/30 bg-primary-subtle text-primary",
        kind === "project" &&
          "border-success/30 bg-success-subtle text-success",
        kind === "skill" &&
          "border-warning/35 bg-warning-subtle text-warning",
      )}
    >
      {label}
    </span>
  );
}

function ToolStatusChip({
  kind,
}: {
  kind: "success" | "failure" | "active";
}) {
  const labels = { success: "Success", failure: "Failed", active: "Running" };
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium",
        kind === "success" && "bg-success-subtle text-success border-success/30",
        kind === "failure" && "bg-danger-subtle text-danger border-danger/30",
        kind === "active" && "bg-primary-subtle text-primary border-primary/30",
      )}
    >
      {kind === "active" && (
        <span className="cc-pulse-working size-1.5 rounded-full bg-current" />
      )}
      {labels[kind]}
    </span>
  );
}

function makeMockToolItem(
  id: string,
  toolName: string,
  args: string,
  output: string,
  ts: number,
): RenderItem {
  return {
    tag: "tool",
    id,
    ts,
    chunk: {
      type: EventType.TOOL_CALL_CHUNK,
      toolCallId: `${id}-tc`,
      toolCallName: toolName,
      delta: args,
      timestamp: ts,
    } as ToolCallChunkEvent,
    result: {
      type: EventType.TOOL_CALL_RESULT,
      messageId: `${id}-tr`,
      toolCallId: `${id}-tc`,
      content: output,
      timestamp: ts + 1500,
    } as ToolCallResultEvent,
  };
}
