import { useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import type { DaemonViewModel, SessionRowViewModel } from "../lib/daemonViewModel";
import { StatusChip } from "./primitives/StatusChip";
import { StatusIcon } from "./primitives/StatusIcon";
import { Spinner } from "./primitives/TypingIndicator";
import type { PwaStartSessionRejected, PwaFsListResult } from "@cc-remote/proto";
import type { PendingCommand } from "../hooks/pendingCommands";
import { PathAutocomplete } from "./primitives/PathAutocomplete";

type FsListSender = (
  daemon_id: string,
  parent: string,
  request_id: string,
  onResult: (frame: PwaFsListResult) => void,
) => () => void;

function daemonLabel(d: { display_name: string | null; hostname: string }): string {
  return d.display_name ?? d.hostname;
}

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
  /** Hub fs_list sender — wired through PathAutocomplete in the cwd field. Optional so test renders that don't care can omit it. */
  fsListSender?: FsListSender;
}

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
  fsListSender,
}: HomeScreenProps) {
  const [killConfirm, setKillConfirm] = useState<string | null>(null);

  return (
    <section
      className="bg-background border-border h-full overflow-y-auto border-r"
      data-testid="home-screen"
    >
      <div className="bg-background sticky top-0 z-10 border-b border-transparent px-4 pt-4 pb-2">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Machines</h2>
          <span className="text-muted-foreground text-xs">
            {daemons.length} daemon{daemons.length === 1 ? "" : "s"}
          </span>
        </div>
      </div>

      <div className="px-4 pb-4">
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
              startSessionError={startSessionErrors?.[d.daemon_id]}
              onDismissStartSessionError={onDismissStartSessionError}
              pendingStart={pendingStartSessionByDaemon?.[d.daemon_id]}
              pendingKillByKey={pendingKillByKey}
              fsListSender={fsListSender}
            />
          ) : (
            <OfflineDaemonCard key={d.daemon_id} daemon={d} />
          ),
        )
      )}
      </div>
    </section>
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
  startSessionError,
  onDismissStartSessionError,
  pendingStart,
  pendingKillByKey,
  fsListSender,
}: {
  daemon: DaemonViewModel;
  killConfirm: string | null;
  setKillConfirm: (id: string | null) => void;
  selectedSessionId?: string;
  onSelectSession: (daemon_id: string, session_id: string) => void;
  onStartSession: (daemon_id: string, cwd: string) => void;
  onKillSession: (daemon_id: string, session_id: string) => void;
  startSessionError?: PwaStartSessionRejected;
  onDismissStartSessionError?: (daemon_id: string) => void;
  pendingStart?: PendingCommand;
  pendingKillByKey?: Record<string, PendingCommand>;
  fsListSender?: FsListSender;
}) {
  const [cwd, setCwd] = useState("");

  const starting = pendingStart?.status === "pending";
  const startTimedOut = pendingStart?.status === "timed_out";

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
          <h3 className="truncate font-semibold">{daemonLabel(daemon)}</h3>
          <p className="text-muted-foreground text-sm">Online</p>
        </div>
        <span className="bg-muted text-muted-foreground rounded-full px-2 py-1 text-xs">
          {daemon.sessions.length} ses
        </span>
      </div>

      <form className="mt-3 flex gap-2" onSubmit={submit}>
        {fsListSender ? (
          <PathAutocomplete
            value={cwd}
            onChange={setCwd}
            daemonId={daemon.daemon_id}
            mode="dirs"
            baseHint="~/"
            sender={fsListSender}
            inputProps={{
              "aria-label": `Working directory for ${daemonLabel(daemon)}`,
              placeholder: "/path/to/project",
              disabled: starting,
            }}
          />
        ) : (
          <input
            aria-label={`Working directory for ${daemonLabel(daemon)}`}
            className="border-border bg-muted text-foreground focus:border-ring focus:ring-ring/30 h-11 min-w-0 flex-1 rounded-md border px-3 font-mono text-sm outline-none focus:ring-2"
            disabled={starting}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="/path/to/project"
            value={cwd}
          />
        )}
        <Button aria-label="Start session" disabled={!cwd.trim() || starting} size="icon" type="submit">
          {starting ? (
            <span data-testid="start-spinner" className="inline-flex">
              <Spinner />
            </span>
          ) : (
            <Plus className="size-4" />
          )}
        </Button>
      </form>

      {starting && (
        <p
          className="text-muted-foreground mt-2 text-sm"
          data-testid={`start-session-pending-${daemon.daemon_id}`}
        >
          Starting session…
        </p>
      )}
      {startTimedOut && (
        <div
          className="bg-danger-subtle text-danger mt-2 rounded-md px-3 py-2 text-sm"
          data-testid={`start-session-timeout-${daemon.daemon_id}`}
          role="alert"
        >
          Start not confirmed. Try again.
        </div>
      )}

      {startSessionError && (
        <div
          className="bg-danger-subtle border-danger/35 mt-2 flex items-start justify-between gap-2 rounded-md border p-2 text-sm"
          data-testid={`start-session-error-${daemon.daemon_id}`}
          role="alert"
        >
          <div className="min-w-0">
            <p className="text-danger font-semibold">
              Couldn't start session ({startSessionError.reason.replace(/_/g, " ")})
            </p>
            <p className="text-muted-foreground truncate">{startSessionError.message}</p>
          </div>
          {onDismissStartSessionError && (
            <Button
              aria-label="Dismiss start-session error"
              onClick={() => onDismissStartSessionError(daemon.daemon_id)}
              size="icon"
              variant="ghost"
            >
              <X className="size-4" />
            </Button>
          )}
        </div>
      )}

      <ul
        className="mt-3 grid gap-2"
        data-testid={`sessions-${daemon.daemon_id}`}
        style={{ paddingLeft: 0, listStyle: "none" }}
      >
        {daemon.sessions.length === 0 ? (
          <li className="text-muted-foreground text-sm">No active sessions.</li>
        ) : (
          daemon.sessions.map((s) => (
            <li
              key={s.session_id}
              className="min-w-0"
              data-testid="session-row"
              data-session-id={s.session_id}
            >
              <SessionRow
                session={s}
                selected={selectedSessionId === s.session_id}
                killConfirm={killConfirm}
                setKillConfirm={setKillConfirm}
                onSelect={() => onSelectSession(s.daemon_id, s.session_id)}
                onKill={() => onKillSession(s.daemon_id, s.session_id)}
                pendingKill={pendingKillByKey?.[`${s.daemon_id}::${s.session_id}`]}
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
          <h3 className="font-semibold">{daemonLabel(daemon)}</h3>
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
                <p className="text-tertiary-foreground truncate font-mono text-[13px]">{s.cwd}</p>
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
  pendingKill,
}: {
  session: SessionRowViewModel;
  selected: boolean;
  killConfirm: string | null;
  setKillConfirm: (id: string | null) => void;
  onSelect: () => void;
  onKill: () => void;
  pendingKill?: PendingCommand;
}) {
  const confirming = killConfirm === session.session_id;
  const killing = pendingKill?.status === "pending";
  const killTimedOut = pendingKill?.status === "timed_out";
  return (
    <div
      className={cn(
        // Nested row inside the daemon card — no shadow, lighter bg so the
        // outer L1 card stays the elevation anchor. Borders + bg-tint carry
        // FSM state so the user can scan the home screen and see at a glance
        // which session Claude is currently active on.
        "bg-muted/40 min-w-0 rounded-md border p-3 cc-transition-state",
        session.state === "waiting" &&
          "border-warning/45 border-l-2 border-l-warning bg-warning-subtle/40",
        session.state === "working" && "border-primary/25 bg-primary-subtle/30",
        session.state === "idle" && "border-border",
        session.state === "offline" && "border-border bg-muted/30 opacity-70",
        // Selection ring goes on top of state chrome — selected always
        // outranks state for the eye-attention.
        selected && "ring-primary/40 bg-primary-subtle/40 ring-2",
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
          {session.state === "waiting" ? (
            <>
              <span className="text-warning mt-1 block truncate text-xs font-semibold">
                {session.activity}
              </span>
              <span className="text-tertiary-foreground mt-1 block truncate font-mono text-[13px]">
                {session.model} · {session.cwd}
              </span>
            </>
          ) : (
            <>
              <span className="text-tertiary-foreground mt-1 block truncate font-mono text-[13px]">
                {session.model} · {session.cwd}
              </span>
              <span className="text-muted-foreground mt-1 block text-xs">
                unread {session.unread} · tasks {session.tasks} · {session.activity}
              </span>
            </>
          )}
        </span>
      </button>
      {killing ? (
        <div
          className="bg-warning-subtle text-warning mt-2 flex items-center gap-2 rounded-md p-2 text-sm cc-enter"
          data-testid={`kill-pending-${session.session_id}`}
        >
          <Spinner className="text-warning" />
          <span>Killing session…</span>
        </div>
      ) : killTimedOut ? (
        <div
          className="bg-danger-subtle text-danger mt-2 rounded-md p-2 text-sm"
          data-testid={`kill-timeout-${session.session_id}`}
          role="alert"
        >
          Kill not confirmed. Try again.
        </div>
      ) : confirming ? (
        <div className="bg-danger-subtle mt-2 flex items-center justify-between gap-2 rounded-md p-2 text-sm cc-enter">
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
