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
          <p className="text-muted-foreground text-sm">Online</p>
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
            <li key={s.session_id} className="min-w-0">
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
        "bg-surface shadow-card min-w-0 rounded-md border p-3",
        session.state === "waiting" ? "border-warning/45" : "border-border",
        selected && "ring-primary/40 ring-2",
      )}
    >
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
