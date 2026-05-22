import {
  AlertCircle,
  ArrowLeft,
  Bell,
  Bot,
  Braces,
  CheckCircle2,
  ChevronRight,
  Circle,
  Clock,
  Copy,
  FileSearch,
  FileText,
  GitBranch,
  Layers,
  Laptop,
  LoaderCircle,
  MessageSquare,
  Monitor,
  Moon,
  MoreHorizontal,
  PackageCheck,
  Pencil,
  Plus,
  Radio,
  Send,
  Settings,
  ShieldAlert,
  Sparkles,
  Split,
  Smartphone,
  Sun,
  Tablet,
  Terminal,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import type React from "react";
import { useMemo, useState } from "react";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { ClaudeCodeMark } from "../screens/primitives/ClaudeCodeMark";
import { Field } from "../screens/primitives/Field";
import { StatusChip, type SessionState } from "../screens/primitives/StatusChip";
import { StatusIcon } from "../screens/primitives/StatusIcon";
import { CatalogCard } from "../screens/timeline/cards/CatalogCard";
import { CatalogHeader } from "../screens/timeline/cards/CatalogHeader";
import {
  AssistantBubble,
  BashToolCard,
  BatchSummaryCard,
  FileEditCard,
  IdleWaitingCard,
  PermissionInlineCard,
  PermissionResolvedCard,
  RawJsonCard,
  ReadSearchCard,
  ReasoningCard,
  SubagentCard,
  SystemNoticeCard,
  TaskCompletedCard,
  TaskCreatedCard,
  ToolFailureCard,
  ToolResultLongCard,
  ToolResultShortCard,
  UserBubble,
  UserBubbleSurface,
} from "../screens/timeline/cards";
import { SessionTimelineItem } from "../screens/timeline/SessionTimelineItem";
import type { TimelineEvent } from "../screens/timeline/types";

type Device = "mobile" | "tablet" | "desktop";
type StepId =
  | "signin"
  | "home"
  | "session"
  | "cards"
  | "permission"
  | "settings";
type Theme = "light" | "dark";

const devices: Array<{ id: Device; label: string; icon: typeof Smartphone }> = [
  { id: "mobile", label: "Mobile", icon: Smartphone },
  { id: "tablet", label: "Tablet", icon: Tablet },
  { id: "desktop", label: "Desktop", icon: Monitor },
];

const steps: Array<{ id: StepId; label: string; note: string }> = [
  {
    id: "signin",
    label: "Sign in",
    note: "A compact, trusted entry point with one SSO action.",
  },
  {
    id: "home",
    label: "Home",
    note: "Machines, sessions, and pending approvals stay visible.",
  },
  {
    id: "session",
    label: "Session",
    note: "Claude Code execution timeline with compact tool cards.",
  },
  {
    id: "cards",
    label: "Cards",
    note: "Card anatomy, variants, states, and density rules.",
  },
  {
    id: "permission",
    label: "Permission",
    note: "Approval becomes a focused decision screen, not a banner.",
  },
  {
    id: "settings",
    label: "Settings",
    note: "Pairing, device revocation, notifications, and appearance.",
  },
];

const sessions: Array<{
  id: string;
  name: string;
  model: string;
  cwd: string;
  activity: string;
  state: SessionState;
  unread: number;
  tasks: number;
}> = [
  {
    id: "s_repo",
    name: "repo-web",
    model: "sonnet",
    cwd: "/Users/me/repo-web",
    activity: "permission needed",
    state: "waiting",
    unread: 2,
    tasks: 7,
  },
  {
    id: "s_api",
    name: "api-server",
    model: "opus",
    cwd: "/Users/me/api",
    activity: "running tool",
    state: "working",
    unread: 0,
    tasks: 12,
  },
  {
    id: "s_tools",
    name: "cli-tools",
    model: "sonnet",
    cwd: "/Users/me/tools",
    activity: "idle 8m",
    state: "idle",
    unread: 0,
    tasks: 3,
  },
];

const timelineEvents: TimelineEvent[] = [
  {
    id: "session-start",
    kind: "session-boundary",
    title: "Session resumed",
    detail: "repo-web on mbp-m3.local - cwd /Users/me/repo-web",
  },
  {
    id: "user-1",
    kind: "user",
    title: "You",
    body: "Fix the failing tests and keep the patch focused.",
    time: "10:41",
  },
  {
    id: "assistant-1",
    kind: "assistant",
    title: "Codex",
    body: "I will inspect the test failures, run the smallest useful suite, and patch only the failing auth path.",
    time: "10:41",
  },
  {
    id: "thinking-1",
    kind: "thinking",
    title: "Reasoning captured",
    body: "Condensed thinking block from the transcript. Hidden by default because it is useful for audit, but noisy during normal remote control.",
    tokens: "428 output tokens",
    time: "10:41",
  },
  {
    id: "tool-read",
    kind: "tool",
    tool: "Read",
    command: "packages/pwa/src/auth.ts",
    cwd: "/Users/me/repo-web",
    duration: "40ms",
    result: "success",
    summary: "Read 96 lines",
    output:
      "1 import { decodeJwt } from './jwt';\n2 export function consumeFragment() {\n...\n96 }",
  },
  {
    id: "tool-bash",
    kind: "tool",
    tool: "Bash",
    command: "bun test --filter auth",
    cwd: "/Users/me/repo-web",
    duration: "12s",
    result: "failure",
    summary: "2 failed, 48 passed",
    output:
      "FAIL src/auth.test.ts\nExpected 200, received 401\nMock token issuer did not match test tenant.",
  },
  {
    id: "permission-inline",
    kind: "permission-inline",
    tool: "Bash",
    command: "rm -rf node_modules",
    risk: "Deletes a project directory recursively. Needs explicit approval.",
  },
  {
    id: "permission-resolved",
    kind: "permission-resolved",
    decision: "allowed",
    via: "PWA - Allow once",
    time: "10:43",
  },
  {
    id: "subagent",
    kind: "subagent",
    name: "test-reviewer",
    status: "completed",
    summary: "Reviewed auth regression scope in parallel.",
    children: [
      "Checked failing assertions",
      "Confirmed no unrelated route failures",
      "Suggested adding issuer fixture coverage",
    ],
  },
  {
    id: "batch",
    kind: "batch",
    summary: "3 tools completed before next model call",
    tools: ["Read", "Grep", "Bash"],
    duration: "13.1s",
  },
  {
    id: "task-created",
    kind: "task",
    title: "Task created",
    status: "created",
    detail: "Patch auth fixture and rerun focused test.",
  },
  {
    id: "task-completed",
    kind: "task",
    title: "Task completed",
    status: "completed",
    detail: "Focused auth suite passes after fixture update.",
  },
  {
    id: "compact",
    kind: "compact",
    title: "Context compacted",
    detail: "Older tool output summarized to preserve working context.",
  },
  {
    id: "metadata",
    kind: "metadata",
    title: "Cwd changed",
    detail: "/Users/me/repo-web -> /Users/me/repo-web/packages/pwa",
  },
  {
    id: "error",
    kind: "error",
    title: "PostToolUseFailure",
    detail:
      "Bash exited with non-zero status code 1. Hook added context for Codex.",
  },
  {
    id: "assistant-2",
    kind: "assistant",
    title: "Codex",
    body: "Found the issue in auth.test.ts. I am updating the mock setup and will rerun the focused test before summarizing.",
    time: "10:44",
  },
  {
    id: "raw",
    kind: "raw",
    title: "Unknown future event",
    json: '{ "type": "ConfigChange", "source": ".claude/settings.json" }',
  },
];

const sessionPreviewEvents: TimelineEvent[] = [
  timelineEvents.find((event) => event.id === "user-1")!,
  timelineEvents.find((event) => event.id === "assistant-1")!,
  timelineEvents.find((event) => event.id === "tool-bash")!,
  timelineEvents.find((event) => event.id === "permission-inline")!,
  timelineEvents.find((event) => event.id === "task-completed")!,
];

export function DemoApp() {
  const [device, setDevice] = useState<Device>("mobile");
  const [step, setStep] = useState<StepId>("home");
  const [theme, setTheme] = useState<Theme>("light");
  const [killConfirm, setKillConfirm] = useState<string | null>(null);
  const [expandedOutput, setExpandedOutput] = useState(false);

  const currentStep = steps.find((item) => item.id === step) ?? steps[0]!;
  const deviceIndex = devices.findIndex((item) => item.id === device);
  const stepIndex = steps.findIndex((item) => item.id === step);

  const goNext = () => {
    setStep(steps[(stepIndex + 1) % steps.length]!.id);
    setKillConfirm(null);
  };

  const switchDevice = () => {
    setDevice(devices[(deviceIndex + 1) % devices.length]!.id);
  };

  const appScreen = useMemo(
    () => (
      <DemoShell
        device={device}
        expandedOutput={expandedOutput}
        killConfirm={killConfirm}
        setExpandedOutput={setExpandedOutput}
        setKillConfirm={setKillConfirm}
        setStep={setStep}
        step={step}
      />
    ),
    [device, expandedOutput, killConfirm, step],
  );

  return (
    <div className={cn(theme === "dark" && "dark")}>
      <main className="bg-background text-foreground min-h-screen px-4 py-5 md:px-6">
        <div className="mx-auto flex max-w-[1440px] flex-col gap-4">
          <section className="rounded-sheet border-border bg-surface shadow-card border p-3 md:p-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <p className="text-muted-foreground text-xs font-semibold tracking-[0.14em] uppercase">
                  cc-remote prototype
                </p>
                <h1 className="text-foreground mt-1 text-xl font-semibold">
                  Three-end guided interaction demo
                </h1>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onClick={switchDevice}>
                  {devices.map(({ id, icon: Icon }) => (
                    <Icon
                      aria-hidden="true"
                      className={cn("hidden size-4", id === device && "block")}
                      key={id}
                    />
                  ))}
                  Switch to {devices[(deviceIndex + 1) % devices.length]!.label}
                </Button>
                <Button
                  aria-label="Toggle theme"
                  onClick={() =>
                    setTheme((value) => (value === "light" ? "dark" : "light"))
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
                <Button onClick={goNext}>
                  Next
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            </div>

            <div className="mt-4 grid gap-3 lg:grid-cols-[260px_1fr]">
              <GuideRail current={step} setStep={setStep} />
              <div className="rounded-card border-border bg-muted border p-3">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold">{currentStep.label}</p>
                    <p className="text-muted-foreground text-xs">
                      {currentStep.note}
                    </p>
                  </div>
                  <DevicePills device={device} setDevice={setDevice} />
                </div>
                {appScreen}
              </div>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}

function GuideRail({
  current,
  setStep,
}: {
  current: StepId;
  setStep: (step: StepId) => void;
}) {
  return (
    <aside className="rounded-card border-border bg-surface grid gap-2 border p-2 lg:content-start">
      {steps.map((item, index) => {
        const active = item.id === current;
        return (
          <button
            className={cn(
              "flex min-h-12 items-start gap-3 rounded-md px-3 py-2 text-left transition-colors",
              active
                ? "bg-primary-subtle text-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
            key={item.id}
            onClick={() => setStep(item.id)}
          >
            <span
              className={cn(
                "mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
                active
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-surface",
              )}
            >
              {index + 1}
            </span>
            <span>
              <span className="block text-sm font-semibold">{item.label}</span>
              <span className="block text-xs">{item.note}</span>
            </span>
          </button>
        );
      })}
    </aside>
  );
}

function DevicePills({
  device,
  setDevice,
}: {
  device: Device;
  setDevice: (device: Device) => void;
}) {
  return (
    <div className="border-border bg-surface inline-flex rounded-full border p-1">
      {devices.map(({ id, label, icon: Icon }) => (
        <button
          className={cn(
            "inline-flex min-h-9 items-center gap-1.5 rounded-full px-3 text-xs font-semibold transition-colors",
            device === id
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
          key={id}
          onClick={() => setDevice(id)}
        >
          <Icon className="size-3.5" />
          {label}
        </button>
      ))}
    </div>
  );
}

function DemoShell({
  device,
  expandedOutput,
  killConfirm,
  setExpandedOutput,
  setKillConfirm,
  setStep,
  step,
}: {
  device: Device;
  expandedOutput: boolean;
  killConfirm: string | null;
  setExpandedOutput: (expanded: boolean) => void;
  setKillConfirm: (id: string | null) => void;
  setStep: (step: StepId) => void;
  step: StepId;
}) {
  return (
    <div className="overflow-x-auto pb-2">
      <div
        className={cn(
          "border-border bg-background shadow-sheet mx-auto overflow-hidden rounded-[28px] border",
          device === "mobile" && "h-[844px] w-[390px]",
          device === "tablet" && "h-[760px] w-[768px]",
          device === "desktop" && "h-[760px] w-[1180px]",
        )}
      >
        {step === "signin" ? (
          <SignInScreen setStep={setStep} />
        ) : (
          <Workbench
            device={device}
            expandedOutput={expandedOutput}
            killConfirm={killConfirm}
            setExpandedOutput={setExpandedOutput}
            setKillConfirm={setKillConfirm}
            setStep={setStep}
            step={step}
          />
        )}
      </div>
    </div>
  );
}

function SignInScreen({ setStep }: { setStep: (step: StepId) => void }) {
  return (
    <div className="bg-background flex h-full flex-col items-center justify-center p-8 text-center">
      <ClaudeCodeMark size="xl" />
      <h2 className="mt-8 text-[28px] leading-9 font-bold">cc-remote</h2>
      <p className="text-muted-foreground mt-2 text-sm">Remote Codex control</p>
      <Button
        className="mt-8 w-full max-w-[320px]"
        onClick={() => setStep("home")}
      >
        Sign in with SSO
      </Button>
      <p className="text-muted-foreground mt-4 text-sm">
        Secure sign-in via SAP IAS
      </p>
      <p className="text-muted-foreground mt-auto text-xs">
        v0.1 - self-hosted hub
      </p>
    </div>
  );
}

function Workbench(props: {
  device: Device;
  expandedOutput: boolean;
  killConfirm: string | null;
  setExpandedOutput: (expanded: boolean) => void;
  setKillConfirm: (id: string | null) => void;
  setStep: (step: StepId) => void;
  step: StepId;
}) {
  const { device, setStep, step } = props;
  const showCards = step === "cards";
  const showSession = step === "session" || step === "permission";
  const showPermission = step === "permission";
  const showSettings = step === "settings";
  const desktop = device === "desktop";
  const tablet = device === "tablet";
  const mobile = device === "mobile";

  return (
    <div className="bg-background relative h-full overflow-hidden">
      <AppHeader device={device} setStep={setStep} />
      <div
        className={cn(
          "h-[calc(100%-56px)]",
          desktop &&
            (showCards
              ? "grid grid-cols-[72px_minmax(0,1fr)]"
              : "grid grid-cols-[72px_370px_minmax(0,1fr)]"),
          tablet && "grid grid-cols-[320px_minmax(0,1fr)]",
          mobile && "block overflow-y-auto",
        )}
      >
        {desktop && <DesktopNav setStep={setStep} />}
        {showCards ? (
          <CardSystemPane device={device} setStep={setStep} />
        ) : (
          <>
            {(!mobile || !showSession) && <HomePane {...props} />}
            {(!mobile || showSession) && (
              <SessionPane {...props} showPermission={showPermission} />
            )}
          </>
        )}
      </div>
      {showPermission && (
        <PermissionSurface device={device} setStep={setStep} />
      )}
      {showSettings && <SettingsSurface device={device} setStep={setStep} />}
    </div>
  );
}

function AppHeader({
  device,
  setStep,
}: {
  device: Device;
  setStep: (step: StepId) => void;
}) {
  return (
    <header className="border-border bg-surface flex h-14 items-center justify-between border-b px-4">
      <div className="flex items-center gap-2">
        <ClaudeCodeMark size="sm" />
        <span className="font-semibold">cc-remote</span>
      </div>
      <div className="flex items-center gap-2">
        <StatusChip label="Connected" tone="online" />
        {device === "desktop" && (
          <Button size="sm" variant="ghost">
            Sign out
          </Button>
        )}
        <Button
          aria-label="Open settings"
          onClick={() => setStep("settings")}
          size="icon"
          variant="ghost"
        >
          <Settings className="size-4" />
        </Button>
      </div>
    </header>
  );
}

function DesktopNav({ setStep }: { setStep: (step: StepId) => void }) {
  return (
    <nav className="border-border bg-surface flex flex-col items-center gap-3 border-r px-3 py-4">
      {[
        { icon: Laptop, step: "home" as const, label: "Machines" },
        { icon: Layers, step: "cards" as const, label: "Cards" },
        { icon: Bell, step: "permission" as const, label: "Permissions" },
        { icon: Settings, step: "settings" as const, label: "Settings" },
      ].map(({ icon: Icon, step, label }) => (
        <button
          aria-label={label}
          className="text-muted-foreground hover:bg-muted hover:text-foreground flex size-11 items-center justify-center rounded-md"
          key={label}
          onClick={() => setStep(step)}
        >
          <Icon className="size-5" />
        </button>
      ))}
    </nav>
  );
}

function HomePane({
  device,
  killConfirm,
  setKillConfirm,
  setStep,
}: {
  device: Device;
  killConfirm: string | null;
  setKillConfirm: (id: string | null) => void;
  setStep: (step: StepId) => void;
}) {
  return (
    <section
      className={cn(
        "bg-background h-full overflow-y-auto p-4",
        device !== "mobile" && "border-border border-r",
      )}
    >
      <PermissionMiniCard setStep={setStep} />
      <div className="mt-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Machines</h2>
        <span className="text-muted-foreground text-xs">2 daemons</span>
      </div>
      <DaemonCard
        hostname="mbp-m3.local"
        online
        sessionCount={3}
        setKillConfirm={setKillConfirm}
        setStep={setStep}
        killConfirm={killConfirm}
      />
      <OfflineDaemonCard />
    </section>
  );
}

function PermissionMiniCard({ setStep }: { setStep: (step: StepId) => void }) {
  return (
    <article className="rounded-card border-warning/35 bg-warning-subtle shadow-card border p-3">
      <div className="flex items-start gap-3">
        <ShieldAlert className="text-warning mt-0.5 size-5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">1 approval waiting</p>
          <p className="text-muted-foreground truncate text-sm">
            mbp-m3 - repo-web - Bash
          </p>
          <code className="bg-code text-code-foreground mt-2 block truncate rounded-sm px-2 py-1 font-mono text-xs">
            rm -rf node_modules
          </code>
        </div>
        <Button
          onClick={() => setStep("permission")}
          size="sm"
          variant="secondary"
        >
          Review
        </Button>
      </div>
    </article>
  );
}

function DaemonCard({
  hostname,
  killConfirm,
  online,
  sessionCount,
  setKillConfirm,
  setStep,
}: {
  hostname: string;
  killConfirm: string | null;
  online: boolean;
  sessionCount: number;
  setKillConfirm: (id: string | null) => void;
  setStep: (step: StepId) => void;
}) {
  return (
    <article className="rounded-card border-border bg-surface shadow-card mt-3 border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate font-semibold">{hostname}</h3>
          <p className="text-muted-foreground text-sm">
            Online - last seen now
          </p>
        </div>
        <span className="bg-muted text-muted-foreground rounded-full px-2 py-1 text-xs">
          {sessionCount} ses
        </span>
      </div>
      {online && (
        <form className="mt-3 flex gap-2">
          <input
            className="border-border bg-muted text-foreground focus:border-ring focus:ring-ring/30 h-11 min-w-0 flex-1 rounded-md border px-3 font-mono text-sm outline-none focus:ring-2"
            defaultValue="/Users/me/project"
            aria-label="Working directory"
          />
          <Button aria-label="Start session" size="icon" type="button">
            <Plus className="size-4" />
          </Button>
        </form>
      )}
      <div className="mt-3 grid gap-2">
        {sessions.map((session) => (
          <SessionRow
            key={session.id}
            killConfirm={killConfirm}
            session={session}
            setKillConfirm={setKillConfirm}
            setStep={setStep}
          />
        ))}
      </div>
    </article>
  );
}

function OfflineDaemonCard() {
  return (
    <article className="rounded-card border-border bg-surface shadow-card mt-3 border p-3 opacity-75">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">dev-vm-eu</h3>
          <p className="text-muted-foreground text-sm">
            Offline - last seen 12m ago
          </p>
        </div>
        <StatusChip label="Offline" tone="offline" />
      </div>
      <div className="border-border bg-muted mt-3 rounded-md border p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate font-semibold">infra</p>
            <p className="text-muted-foreground truncate font-mono text-xs">
              /terraform
            </p>
          </div>
          <StatusChip label="Offline" tone="offline" />
        </div>
      </div>
    </article>
  );
}

function SessionRow({
  killConfirm,
  session,
  setKillConfirm,
  setStep,
}: {
  killConfirm: string | null;
  session: (typeof sessions)[number];
  setKillConfirm: (id: string | null) => void;
  setStep: (step: StepId) => void;
}) {
  const confirming = killConfirm === session.id;
  return (
    <div
      className={cn(
        "bg-surface shadow-card rounded-md border p-3",
        session.state === "waiting" ? "border-warning/45" : "border-border",
      )}
    >
      <button
        className="flex min-h-[44px] w-full items-start gap-3 text-left"
        onClick={() => setStep("session")}
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
          <span className="text-muted-foreground mt-1 block truncate font-mono text-xs">
            {session.model} - {session.cwd}
          </span>
          <span className="text-muted-foreground mt-1 block text-xs">
            unread {session.unread} - tasks {session.tasks} - {session.activity}
          </span>
        </span>
      </button>
      {confirming ? (
        <div className="bg-danger-subtle mt-2 flex items-center justify-between gap-2 rounded-md p-2 text-sm">
          <span className="text-danger font-semibold">Kill session?</span>
          <span className="flex gap-2">
            <Button
              onClick={() => setKillConfirm(null)}
              size="sm"
              variant="secondary"
            >
              Cancel
            </Button>
            <Button
              onClick={() => setKillConfirm(null)}
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
            onClick={() => setKillConfirm(session.id)}
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

function SessionPane({
  device,
  expandedOutput,
  setExpandedOutput,
  setStep,
  showPermission,
}: {
  device: Device;
  expandedOutput: boolean;
  setExpandedOutput: (expanded: boolean) => void;
  setStep: (step: StepId) => void;
  showPermission: boolean;
}) {
  return (
    <section
      className={cn(
        "bg-background flex h-full min-w-0 flex-col",
        device === "desktop" && showPermission && "pr-[390px]",
      )}
    >
      <div className="border-border bg-surface flex min-h-14 items-center justify-between border-b px-4">
        <div className="flex min-w-0 items-center gap-2">
          {device === "mobile" && (
            <Button
              aria-label="Back to home"
              onClick={() => setStep("home")}
              size="icon"
              variant="ghost"
            >
              <ArrowLeft className="size-4" />
            </Button>
          )}
          <div className="min-w-0">
            <h2 className="truncate font-semibold">repo-web</h2>
            <p className="text-muted-foreground truncate font-mono text-xs">
              sonnet - /Users/me/repo-web
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <StatusChip label="Online" tone="online" />
          <Button size="icon" variant="ghost">
            <MoreHorizontal className="size-4" />
          </Button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3">
        <SessionExecutionTimeline />
        {showPermission && (
          <article className="rounded-card border-warning/35 bg-warning-subtle mt-3 border p-3">
            <p className="text-warning font-semibold">Permission required</p>
            <p className="text-muted-foreground mt-1 text-sm">
              Review the Bash command before Codex can continue.
            </p>
            <Button
              className="mt-3"
              onClick={() => setStep("permission")}
              size="sm"
              variant="secondary"
            >
              Review permission
            </Button>
          </article>
        )}
      </div>
      <Composer blocked={showPermission} setStep={setStep} />
    </section>
  );
}

function SessionExecutionTimeline() {
  return (
    <div className="relative pb-3 pl-8">
      <div className="bg-border absolute top-2 bottom-2 left-3.5 w-px" />
      <div className="mb-4">
        <UserBubbleSurface />
      </div>

      <SessionTimelineItem marker="claude">
        <SessionClaudeTurnCard />
      </SessionTimelineItem>

      <SessionTimelineItem marker="claude">
        <CatalogCard>
          <CatalogHeader icon={Terminal} title="Claude" meta="10:28 AM" />
          <p className="mt-2 leading-5">
            Added reset flow and tests. Ready for review.
          </p>
        </CatalogCard>
      </SessionTimelineItem>

      <SessionTimelineItem marker="success">
        <TaskCompletedCard />
      </SessionTimelineItem>

      <SessionTimelineItem marker="idle">
        <IdleWaitingCard />
      </SessionTimelineItem>
    </div>
  );
}

function SessionClaudeTurnCard() {
  return (
    <CatalogCard>
      <CatalogHeader icon={Terminal} title="Claude" meta="10:24 AM" />
      <p className="mt-2 leading-5">
        I'll plan the implementation and create the necessary endpoints.
      </p>
      <div className="mt-3 grid gap-2">
        <ReasoningCard />
        <BashToolCard />
        <FileEditCard />
        <ReadSearchCard />
      </div>
    </CatalogCard>
  );
}

function CardSystemPane({
  device,
  setStep,
}: {
  device: Device;
  setStep: (step: StepId) => void;
}) {
  return (
    <section className="bg-background col-span-full h-full min-w-0 overflow-y-auto p-4">
      <div className="mx-auto max-w-[1280px]">
        <div className="border-border bg-surface sticky top-0 z-10 -mx-4 border-b px-4 py-3">
          <div className="mx-auto flex max-w-[1280px] items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              {device === "mobile" && (
                <Button
                  aria-label="Back to home"
                  onClick={() => setStep("home")}
                  size="icon"
                  variant="ghost"
                >
                  <ArrowLeft className="size-4" />
                </Button>
              )}
              <div className="min-w-0">
                <h2 className="truncate text-lg font-semibold">
                  Session Timeline Card System
                </h2>
                <p className="text-muted-foreground truncate text-xs">
                  Complete catalog for chat, tools, permissions, workflow,
                  system, and fallback events.
                </p>
              </div>
            </div>
            <Button size="sm" variant="secondary">
              Light mode
            </Button>
          </div>
        </div>

        <div
          className={cn(
            "grid gap-5 py-4",
            device !== "mobile" && "grid-cols-[360px_minmax(0,1fr)]",
          )}
        >
          {device === "mobile" ? (
            <>
              <CardCatalog device={device} />
              <MiniTimelinePreview />
            </>
          ) : (
            <>
              <MiniTimelinePreview />
              <CardCatalog device={device} />
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function MiniTimelinePreview() {
  return (
    <aside className="border-border bg-surface shadow-card rounded-[22px] border">
      <div className="border-border flex h-20 items-center justify-between border-b px-4">
        <Button aria-label="Back" size="icon" variant="ghost">
          <ArrowLeft className="size-4" />
        </Button>
        <div className="text-center">
          <p className="font-semibold">feat_auth</p>
          <p className="text-muted-foreground text-xs">
            work-laptop - ~/awesome-project
          </p>
        </div>
        <MoreHorizontal className="text-muted-foreground size-4" />
      </div>
      <div className="space-y-3 p-4">
        <UserBubble />
        <AssistantBubble />
        <BashToolCard />
        <FileEditCard />
        <ReadSearchCard />
        <TaskCompletedCard />
        <IdleWaitingCard />
      </div>
      <div className="border-border border-t p-4">
        <div className="border-border bg-muted flex h-11 items-center justify-between rounded-md border px-3">
          <span className="text-muted-foreground text-sm">Message Claude...</span>
          <Send className="text-primary size-4" />
        </div>
      </div>
    </aside>
  );
}

function CardCatalog({ device }: { device: Device }) {
  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">Session Timeline Card Components</h3>
        <p className="text-muted-foreground text-xs">20 card types</p>
      </div>
      <div className="space-y-3">
        <CatalogGroup device={device}>
          <CatalogTile number={1} title="User Bubble (Right)">
            <UserBubble />
          </CatalogTile>
          <CatalogTile number={2} title="Assistant Bubble (Left)">
            <AssistantBubble />
          </CatalogTile>
          <CatalogTile number={3} title="Reasoning (Collapsed)">
            <ReasoningCard />
          </CatalogTile>
          <CatalogTile number={4} title="Bash Tool">
            <BashToolCard />
          </CatalogTile>
        </CatalogGroup>
        <CatalogGroup device={device}>
          <CatalogTile number={5} title="File Edit">
            <FileEditCard />
          </CatalogTile>
          <CatalogTile number={6} title="Read / Grep / Glob">
            <ReadSearchCard />
          </CatalogTile>
          <CatalogTile number={7} title="Tool Result (Short Success)">
            <ToolResultShortCard />
          </CatalogTile>
          <CatalogTile number={8} title="Tool Result (Long Output)">
            <ToolResultLongCard />
          </CatalogTile>
        </CatalogGroup>
        <CatalogGroup device={device}>
          <CatalogTile number={9} title="Tool Failure / Error">
            <ToolFailureCard />
          </CatalogTile>
          <CatalogTile number={10} title="Permission Request (Inline)">
            <PermissionInlineCard />
          </CatalogTile>
          <CatalogTile number={11} title="Permission Review (Card)">
            <CatalogPermissionReview />
          </CatalogTile>
          <CatalogTile number={12} title="Permission Resolved (Inline)">
            <PermissionResolvedCard />
          </CatalogTile>
        </CatalogGroup>
        <CatalogGroup device={device}>
          <CatalogTile number={13} title="Batch Summary">
            <BatchSummaryCard />
          </CatalogTile>
          <CatalogTile number={14} title="Subagent Group (Collapsed)">
            <SubagentCard />
          </CatalogTile>
          <CatalogTile number={15} title="Subagent Group (Expanded)">
            <SubagentCard expanded />
          </CatalogTile>
          <CatalogTile number={16} title="Task Created (Chip Row)">
            <TaskCreatedCard />
          </CatalogTile>
        </CatalogGroup>
        <CatalogGroup device={device}>
          <CatalogTile number={17} title="Task Completed">
            <TaskCompletedCard />
          </CatalogTile>
          <CatalogTile number={18} title="System Metadata / Notice">
            <SystemNoticeCard />
          </CatalogTile>
          <CatalogTile number={19} title="Unknown / Raw JSON">
            <RawJsonCard />
          </CatalogTile>
          <CatalogTile number={20} title="Idle / Waiting">
            <IdleWaitingCard />
          </CatalogTile>
        </CatalogGroup>
      </div>
    </section>
  );
}

function CatalogGroup({
  children,
  device,
}: {
  children: React.ReactNode;
  device: Device;
}) {
  return (
    <div
      className={cn(
        "border-border bg-surface rounded-card grid gap-3 border p-3",
        device === "mobile" && "grid-cols-1",
        device === "tablet" && "grid-cols-2",
        device === "desktop" && "grid-cols-4",
      )}
    >
      {children}
    </div>
  );
}

function CatalogTile({
  children,
  number,
  title,
}: {
  children: React.ReactNode;
  number: number;
  title: string;
}) {
  return (
    <div className="min-w-0">
      <p className="text-muted-foreground mb-2 text-xs font-semibold">
        {number}. {title}
      </p>
      {children}
    </div>
  );
}

function CatalogPermissionReview() {
  return (
    <CatalogCard tone="warning">
      <CatalogHeader icon={ShieldAlert} title="Permission required" tone="warning" />
      <p className="text-muted-foreground mt-1 text-xs">work-laptop - feat_auth</p>
      <div className="mt-3 grid gap-1 text-xs">
        <p>Tool <span className="ml-6 font-mono">Bash</span></p>
        <p>Command <span className="font-mono">rm -rf node_modules</span></p>
        <p>Working directory <span className="font-mono">/Users/me/project</span></p>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        <Button size="sm" variant="danger">Deny</Button>
        <Button size="sm">Allow once</Button>
        <Button size="sm" variant="secondary">Always</Button>
      </div>
    </CatalogCard>
  );
}

function TimelineLegend({ compact }: { compact: boolean }) {
  const items = [
    { label: "Chat", icon: MessageSquare },
    { label: "Tools", icon: Wrench },
    { label: "Decision", icon: ShieldAlert },
    { label: "System", icon: Layers },
  ];

  return (
    <div className="border-border bg-background/95 sticky top-0 z-10 -mx-4 mt-3 border-y px-4 py-2 backdrop-blur">
      <div className="flex items-center justify-between gap-3">
        <p className="text-muted-foreground text-xs font-semibold tracking-[0.12em] uppercase">
          Event timeline
        </p>
        {!compact && (
          <div className="flex gap-1.5">
            {items.map(({ icon: Icon, label }) => (
              <span
                className="border-border bg-surface text-muted-foreground inline-flex h-7 items-center gap-1.5 rounded-full border px-2 text-xs"
                key={label}
              >
                <Icon className="size-3.5" />
                {label}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function EventTimeline({
  events,
  expandedOutput,
  setExpandedOutput,
}: {
  events: TimelineEvent[];
  expandedOutput: boolean;
  setExpandedOutput: (expanded: boolean) => void;
}) {
  return (
    <div className="relative mt-3 space-y-3 pb-3">
      <div className="bg-border absolute top-0 bottom-0 left-4 w-px" />
      {events.map((event) => (
        <TimelineEventCard
          event={event}
          expandedOutput={expandedOutput}
          key={event.id}
          setExpandedOutput={setExpandedOutput}
        />
      ))}
    </div>
  );
}

function TimelineEventCard({
  event,
  expandedOutput,
  setExpandedOutput,
}: {
  event: TimelineEvent;
  expandedOutput: boolean;
  setExpandedOutput: (expanded: boolean) => void;
}) {
  switch (event.kind) {
    case "user":
      return (
        <TimelineShell marker="chat">
          <ChatBubble align="right" title={event.title}>
            {event.body}
            <span className="text-muted-foreground mt-2 block text-xs">
              {event.time}
            </span>
          </ChatBubble>
        </TimelineShell>
      );
    case "assistant":
      return (
        <TimelineShell marker="assistant">
          <ChatBubble title={event.title}>
            {event.body}
            <span className="text-muted-foreground mt-2 block text-xs">
              {event.time}
            </span>
          </ChatBubble>
        </TimelineShell>
      );
    case "thinking":
      return (
        <TimelineShell marker="system">
          <ThinkingCard event={event} />
        </TimelineShell>
      );
    case "tool":
      return (
        <TimelineShell marker={event.result === "failure" ? "error" : "tool"}>
          <ToolCard
            event={event}
            expanded={expandedOutput}
            setExpanded={setExpandedOutput}
          />
        </TimelineShell>
      );
    case "permission-inline":
      return (
        <TimelineShell marker="permission">
          <InlinePermissionCard event={event} />
        </TimelineShell>
      );
    case "permission-resolved":
      return (
        <TimelineShell marker="success">
          <PermissionResolvedNotice event={event} />
        </TimelineShell>
      );
    case "subagent":
      return (
        <TimelineShell marker="subagent">
          <SubagentLiveCard event={event} />
        </TimelineShell>
      );
    case "batch":
      return (
        <TimelineShell marker="tool">
          <ToolBatchCard event={event} />
        </TimelineShell>
      );
    case "task":
      return (
        <TimelineShell
          marker={event.status === "completed" ? "success" : "tool"}
        >
          <TaskCard event={event} />
        </TimelineShell>
      );
    case "system":
    case "compact":
    case "session-boundary":
    case "metadata":
      return (
        <TimelineShell marker="system">
          <SystemNotice event={event} />
        </TimelineShell>
      );
    case "error":
      return (
        <TimelineShell marker="error">
          <ErrorCard event={event} />
        </TimelineShell>
      );
    case "raw":
      return (
        <TimelineShell marker="raw">
          <RawEventCard event={event} />
        </TimelineShell>
      );
  }
}

function TimelineShell({
  children,
  marker,
}: {
  children: React.ReactNode;
  marker:
    | "assistant"
    | "chat"
    | "error"
    | "permission"
    | "raw"
    | "subagent"
    | "success"
    | "system"
    | "tool";
}) {
  const markerClasses = {
    assistant: "border-primary/30 bg-primary-subtle text-primary",
    chat: "border-primary/30 bg-primary text-primary-foreground",
    error: "border-danger/35 bg-danger-subtle text-danger",
    permission: "border-warning/35 bg-warning-subtle text-warning",
    raw: "border-border bg-muted text-muted-foreground",
    subagent: "border-primary/30 bg-surface text-primary",
    success: "border-success/30 bg-success-subtle text-success",
    system: "border-border bg-surface text-muted-foreground",
    tool: "border-border bg-muted text-foreground",
  };

  const markerIcons = {
    assistant: Bot,
    chat: MessageSquare,
    error: AlertCircle,
    permission: ShieldAlert,
    raw: Braces,
    subagent: Split,
    success: CheckCircle2,
    system: Layers,
    tool: Wrench,
  };
  const Icon = markerIcons[marker];

  return (
    <div className="relative grid grid-cols-[32px_minmax(0,1fr)] gap-3">
      <span
        className={cn(
          "shadow-card relative z-10 flex size-8 items-center justify-center rounded-full border",
          markerClasses[marker],
        )}
      >
        <Icon className="size-4" />
      </span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function ChatBubble({
  align = "left",
  children,
  title,
}: {
  align?: "left" | "right";
  children: React.ReactNode;
  title: string;
}) {
  return (
    <article
      className={cn(
        "rounded-card shadow-card max-w-[88%] border p-3",
        align === "right"
          ? "border-primary/25 bg-primary-subtle ml-auto"
          : "border-border bg-surface mr-auto",
      )}
    >
      <p className="text-muted-foreground text-xs font-semibold">{title}</p>
      <p className="mt-1 text-sm leading-6">{children}</p>
    </article>
  );
}

function ToolCard({
  event,
  expanded,
  setExpanded,
}: {
  event: Extract<TimelineEvent, { kind: "tool" }>;
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
}) {
  const failed = event.result === "failure";
  const running = event.result === "running";

  return (
    <article
      className={cn(
        "rounded-card bg-muted shadow-card border p-3",
        failed ? "border-danger/40" : "border-border",
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {running ? (
            <LoaderCircle className="text-primary size-4 animate-spin" />
          ) : (
            <Terminal className={cn("size-4", failed && "text-danger")} />
          )}
          <p className="font-mono text-sm font-semibold">{event.tool}</p>
        </div>
        <span className="text-muted-foreground text-xs">{event.duration}</span>
      </div>
      <code className="bg-code text-code-foreground mt-2 block rounded-md px-3 py-2 font-mono text-xs">
        {event.command}
      </code>
      <p className="text-muted-foreground mt-2 truncate font-mono text-xs">
        cwd: {event.cwd}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <StatusChip
          label={failed ? "Failed" : running ? "Running" : "Succeeded"}
          tone={failed ? "error" : running ? "working" : "online"}
        />
        <span className="text-muted-foreground text-xs">{event.summary}</span>
        {event.risk && (
          <span className="border-warning/30 bg-warning-subtle text-warning rounded-full border px-2 py-1 text-xs font-semibold">
            {event.risk}
          </span>
        )}
      </div>
      {expanded && (
        <pre className="border-code-border bg-code text-code-foreground mt-3 max-h-40 overflow-auto rounded-md border p-3 font-mono text-xs leading-5">
          {event.output}
        </pre>
      )}
      <Button
        className="mt-2"
        onClick={() => setExpanded(!expanded)}
        size="sm"
        variant="tertiary"
      >
        {expanded ? "Collapse" : "View output"}
      </Button>
    </article>
  );
}

function ThinkingCard({
  event,
}: {
  event: Extract<TimelineEvent, { kind: "thinking" }>;
}) {
  return (
    <details className="rounded-card border-border bg-surface shadow-card border p-3">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
        <span className="flex items-center gap-2 font-semibold">
          <Sparkles className="text-primary size-4" />
          {event.title}
        </span>
        <span className="text-muted-foreground text-xs">{event.tokens}</span>
      </summary>
      <p className="text-muted-foreground mt-3 text-sm leading-6">
        {event.body}
      </p>
    </details>
  );
}

function InlinePermissionCard({
  event,
}: {
  event: Extract<TimelineEvent, { kind: "permission-inline" }>;
}) {
  return (
    <article className="rounded-card border-warning/35 bg-warning-subtle shadow-card border p-3">
      <div className="flex items-start gap-3">
        <ShieldAlert className="text-warning mt-0.5 size-5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">PermissionRequest</p>
          <p className="text-muted-foreground mt-1 text-sm">
            {event.tool} needs approval before execution.
          </p>
          <code className="bg-code text-code-foreground mt-2 block truncate rounded-md px-3 py-2 font-mono text-xs">
            {event.command}
          </code>
          <p className="text-warning mt-2 text-sm">{event.risk}</p>
        </div>
      </div>
    </article>
  );
}

function PermissionResolvedNotice({
  event,
}: {
  event: Extract<TimelineEvent, { kind: "permission-resolved" }>;
}) {
  return (
    <article className="rounded-card border-success/30 bg-success-subtle border p-3">
      <p className="text-success font-semibold">Permission {event.decision}</p>
      <p className="text-muted-foreground mt-1 text-sm">
        {event.via} - {event.time}
      </p>
    </article>
  );
}

function SubagentLiveCard({
  event,
}: {
  event: Extract<TimelineEvent, { kind: "subagent" }>;
}) {
  return (
    <details
      open
      className="rounded-card border-border bg-surface shadow-card border p-3"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2">
          <Split className="text-primary size-4" />
          <span className="truncate font-semibold">{event.name}</span>
        </span>
        <StatusChip
          label={event.status === "completed" ? "Done" : "Running"}
          tone={event.status === "completed" ? "online" : "working"}
        />
      </summary>
      <p className="text-muted-foreground mt-3 text-sm">{event.summary}</p>
      <ul className="mt-3 grid gap-1 text-sm">
        {event.children.map((child) => (
          <li className="flex items-center gap-2" key={child}>
            <CheckCircle2 className="text-success size-3.5" />
            {child}
          </li>
        ))}
      </ul>
    </details>
  );
}

function ToolBatchCard({
  event,
}: {
  event: Extract<TimelineEvent, { kind: "batch" }>;
}) {
  return (
    <article className="rounded-card border-border bg-muted border p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-2 font-semibold">
          <PackageCheck className="text-primary size-4" />
          PostToolBatch
        </p>
        <span className="text-muted-foreground text-xs">{event.duration}</span>
      </div>
      <p className="text-muted-foreground mt-1 text-sm">{event.summary}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {event.tools.map((tool) => (
          <span
            className="border-border bg-surface rounded-full border px-2 py-1 font-mono text-xs"
            key={tool}
          >
            {tool}
          </span>
        ))}
      </div>
    </article>
  );
}

function TaskCard({
  event,
}: {
  event: Extract<TimelineEvent, { kind: "task" }>;
}) {
  return (
    <article className="rounded-card border-border bg-surface border p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-2 font-semibold">
          {event.status === "completed" ? (
            <CheckCircle2 className="text-success size-4" />
          ) : (
            <Clock className="text-primary size-4" />
          )}
          {event.title}
        </p>
        <StatusChip
          label={event.status === "completed" ? "Completed" : "Created"}
          tone={event.status === "completed" ? "online" : "working"}
        />
      </div>
      <p className="text-muted-foreground mt-1 text-sm">{event.detail}</p>
    </article>
  );
}

function SystemNotice({
  event,
}: {
  event: Extract<
    TimelineEvent,
    { kind: "compact" | "metadata" | "session-boundary" | "system" }
  >;
}) {
  const icon =
    event.kind === "compact"
      ? Layers
      : event.kind === "metadata"
        ? GitBranch
        : event.kind === "session-boundary"
          ? FileText
          : Bell;
  const Icon = icon;

  return (
    <article className="rounded-card border-border bg-surface/70 border px-3 py-2">
      <p className="flex items-center gap-2 text-sm font-semibold">
        <Icon className="text-muted-foreground size-4" />
        {event.title}
      </p>
      <p className="text-muted-foreground mt-1 text-sm">{event.detail}</p>
    </article>
  );
}

function ErrorCard({
  event,
}: {
  event: Extract<TimelineEvent, { kind: "error" }>;
}) {
  return (
    <article className="rounded-card border-danger/40 bg-danger-subtle shadow-card border p-3">
      <p className="text-danger flex items-center gap-2 font-semibold">
        <AlertCircle className="size-4" />
        {event.title}
      </p>
      <p className="text-muted-foreground mt-1 text-sm leading-6">
        {event.detail}
      </p>
      <Button className="mt-3" size="sm" variant="danger">
        Inspect failure
      </Button>
    </article>
  );
}

function RawEventCard({
  event,
}: {
  event: Extract<TimelineEvent, { kind: "raw" }>;
}) {
  return (
    <details className="rounded-card border-border bg-muted border p-3">
      <summary className="flex cursor-pointer list-none items-center gap-2 font-semibold">
        <Braces className="text-muted-foreground size-4" />
        {event.title}
      </summary>
      <pre className="bg-code text-code-foreground mt-3 overflow-auto rounded-md p-3 font-mono text-xs">
        {event.json}
      </pre>
    </details>
  );
}

function Composer({
  blocked,
  setStep,
}: {
  blocked: boolean;
  setStep: (step: StepId) => void;
}) {
  return (
    <div className="border-border bg-surface border-t p-3 pb-[calc(12px+env(safe-area-inset-bottom))]">
      {blocked && (
        <div className="bg-warning-subtle text-warning mb-2 flex items-center justify-between gap-2 rounded-md px-3 py-2 text-sm">
          <span>Permission required before Codex can continue.</span>
          <Button
            onClick={() => setStep("permission")}
            size="sm"
            variant="secondary"
          >
            Review
          </Button>
        </div>
      )}
      <div className="flex gap-2">
        <input
          className="border-border bg-muted focus:border-ring focus:ring-ring/30 disabled:text-disabled h-11 min-w-0 flex-1 rounded-md border px-3 text-base outline-none focus:ring-2"
          disabled={blocked}
          placeholder={blocked ? "Waiting for permission" : "Message Claude..."}
        />
        <Button disabled={blocked} size="icon">
          <Send className="size-4" />
        </Button>
      </div>
    </div>
  );
}

function PermissionSurface({
  device,
  setStep,
}: {
  device: Device;
  setStep: (step: StepId) => void;
}) {
  const card = <PermissionCard setStep={setStep} />;

  if (device === "desktop") {
    return (
      <aside className="border-border bg-elevated shadow-sheet absolute top-14 right-0 bottom-0 w-[390px] border-l p-4">
        {card}
      </aside>
    );
  }

  return (
    <div className="bg-overlay absolute inset-0 p-4">
      <div
        className={cn(
          "bg-elevated shadow-sheet mx-auto",
          device === "mobile"
            ? "rounded-t-sheet mt-[60px] h-[calc(100%-60px)] p-4"
            : "rounded-sheet mt-20 max-w-[520px] p-5",
        )}
      >
        {card}
      </div>
    </div>
  );
}

function PermissionCard({ setStep }: { setStep: (step: StepId) => void }) {
  return (
    <article className="flex h-full flex-col">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-warning flex items-center gap-2">
            <ShieldAlert className="size-5" />
            <h2 className="text-foreground text-lg font-semibold">
              Codex requests permission
            </h2>
          </div>
          <p className="text-muted-foreground mt-1 text-sm">
            repo-web - mbp-m3.local
          </p>
        </div>
        <Button
          aria-label="Back to session"
          onClick={() => setStep("session")}
          size="icon"
          variant="ghost"
        >
          <X className="size-4" />
        </Button>
      </div>

      <div className="mt-5 grid gap-4">
        <Field label="Tool" value="Bash" />
        <Field label="Working directory" value="/Users/me/repo-web" mono />
        <div>
          <p className="text-muted-foreground text-xs font-semibold tracking-[0.12em] uppercase">
            Command
          </p>
          <code className="border-code-border bg-code text-code-foreground mt-2 block rounded-md border p-3 font-mono text-sm">
            rm -rf node_modules
          </code>
        </div>
        <div className="rounded-card border-warning/35 bg-warning-subtle border p-3">
          <p className="text-warning font-semibold">High risk</p>
          <ul className="text-muted-foreground mt-2 space-y-1 text-sm">
            <li>removes a directory recursively</li>
            <li>targets project-local dependencies</li>
            <li>does not target system root</li>
          </ul>
        </div>
        <p className="text-muted-foreground text-sm">1 of 3 pending</p>
      </div>

      <div className="mt-auto pt-5">
        <div className="grid grid-cols-2 gap-3">
          <Button
            onClick={() => setStep("session")}
            size="lg"
            variant="secondary"
          >
            Deny permission
          </Button>
          <Button onClick={() => setStep("session")} size="lg">
            Allow once
          </Button>
        </div>
        <Button className="mt-3 w-full" size="lg" variant="tertiary">
          Configure allow always
        </Button>
      </div>
    </article>
  );
}

function SettingsSurface({
  device,
  setStep,
}: {
  device: Device;
  setStep: (step: StepId) => void;
}) {
  return (
    <div className="bg-overlay absolute inset-0">
      <aside
        className={cn(
          "bg-elevated shadow-sheet ml-auto h-full p-4",
          device === "mobile" ? "w-full" : "w-[410px]",
        )}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Settings</h2>
          <Button
            aria-label="Close settings"
            onClick={() => setStep("home")}
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
            <DeviceCard name="mbp-m3.local" status="Online" />
            <DeviceCard name="dev-vm-eu" status="Offline" />
          </SettingsSection>
          <SettingsSection title="Pair new daemon">
            <div className="rounded-card border-border bg-muted border p-4 text-center">
              <p className="text-muted-foreground text-sm">Pairing code</p>
              <p className="mt-3 font-mono text-2xl font-semibold">482-913</p>
              <p className="text-muted-foreground mt-2 text-xs">
                Expires in 10:00
              </p>
              <Button className="mt-3" size="sm" variant="secondary">
                <Copy className="size-4" />
                Copy code
              </Button>
            </div>
          </SettingsSection>
          <SettingsSection title="Notifications">
            <ToggleRow label="Permission alerts" value="On" />
          </SettingsSection>
          <SettingsSection title="Appearance">
            <div className="grid grid-cols-3 gap-2">
              {["System", "Light", "Dark"].map((item) => (
                <Button key={item} size="sm" variant="secondary">
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

function DeviceCard({ name, status }: { name: string; status: string }) {
  return (
    <div className="rounded-card border-border bg-surface mb-2 border p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="font-semibold">{name}</p>
          <p className="text-muted-foreground text-xs">paired May 20</p>
        </div>
        <span className="text-muted-foreground text-xs">{status}</span>
      </div>
      <Button className="mt-2" size="sm" variant="danger">
        Revoke
      </Button>
    </div>
  );
}

function ToggleRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-card border-border bg-surface flex items-center justify-between border p-3">
      <span className="text-sm">{label}</span>
      <span className="bg-success-subtle text-success rounded-full px-2 py-1 text-xs font-semibold">
        {value}
      </span>
    </div>
  );
}

function stateLabel(state: SessionState) {
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
