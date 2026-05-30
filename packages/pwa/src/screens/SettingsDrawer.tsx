import { useState } from "react";
import { Copy, X } from "lucide-react";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import type { Device } from "../hooks/useMediaQuery";
import type { Resource } from "../hooks/types";
import type { DaemonItem } from "../hooks/useDaemons";
import type { PushTopicsState, DndSettings } from "../hooks/usePushTopics";
import { resolveSubscription } from "../hooks/usePushTopics";
import type { PairingState } from "../hooks/usePairing";

export type Appearance = "system" | "light" | "dark";

export interface SettingsDrawerProps {
  device: Device;
  account: { email: string; onSignOut: () => void };
  daemons: Resource<DaemonItem[]>;
  onRenameDaemon: (daemon_id: string, display_name: string) => void;
  onRevokeDaemon: (daemon_id: string) => void;
  pushState: Resource<PushTopicsState>;
  onSetSub: (topic_id: string, daemon_id: string | null, enabled: boolean) => Promise<void>;
  onResetDaemon: (daemon_id: string) => Promise<void>;
  onSetDnd: (dnd: DndSettings) => Promise<void>;
  pairing: PairingState;
  onGenerateCode: () => void;
  onCancelPairing: () => void;
  appearance: Appearance;
  onSetAppearance: (mode: Appearance) => void;
  daemonActionError?: string | null;
  pushActionError?: string | null;
  pairingError?: string | null;
  onClose: () => void;
}

export function SettingsDrawer(props: SettingsDrawerProps) {
  const {
    device, account, daemons, onRenameDaemon, onRevokeDaemon,
    pushState, onSetSub, onResetDaemon, onSetDnd,
    pairing, onGenerateCode, onCancelPairing,
    appearance, onSetAppearance,
    daemonActionError, pushActionError, pairingError,
    onClose,
  } = props;

  return (
    <div
      className="bg-overlay fixed inset-0 z-50 flex"
      data-testid="settings-drawer"
      onClick={onClose}
    >
      <aside
        className={cn(
          "bg-surface shadow-sheet ml-auto h-full overflow-y-auto p-4",
          device === "mobile" ? "w-full" : "w-[420px]",
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Settings</h2>
          <Button aria-label="Close settings" onClick={onClose} size="icon" variant="ghost">
            <X className="size-4" />
          </Button>
        </div>

        <div className="mt-5 space-y-5">
          <Section title="Account">
            <p className="text-muted-foreground text-sm">{account.email}</p>
            <Button className="mt-3" onClick={account.onSignOut} size="sm" variant="secondary">
              Sign out
            </Button>
          </Section>

          <Section title="Paired daemons">
            <ResourceView
              resource={daemons}
              empty={<p className="text-muted-foreground text-sm">No daemons paired.</p>}
              render={(list) => list.map((d) => (
                <DaemonRow key={d.daemon_id} daemon={d} onRename={onRenameDaemon} onRevoke={onRevokeDaemon} />
              ))}
            />
            {daemonActionError && (
              <p className="text-danger mt-2 text-sm">{daemonActionError}</p>
            )}
          </Section>

          <Section title="Pair new daemon">
            <PairCodeBox
              pairing={pairing}
              onGenerate={onGenerateCode}
              onCancel={onCancelPairing}
              error={pairingError ?? null}
            />
          </Section>

          <Section title="Notifications">
            <ResourceView
              resource={pushState}
              render={(s) => (
                <>
                  <DndBlock dnd={s.dnd} onSave={onSetDnd} />
                  <DefaultsBlock state={s} onSetSub={onSetSub} />
                  <PerDaemonBlock state={s} daemons={daemons} onSetSub={onSetSub} onResetDaemon={onResetDaemon} />
                </>
              )}
            />
            {pushActionError && (
              <p className="text-danger mt-2 text-sm">{pushActionError}</p>
            )}
          </Section>

          <Section title="Appearance">
            <div className="grid grid-cols-3 gap-2">
              {(["system", "light", "dark"] as const).map((mode) => (
                <Button
                  key={mode}
                  onClick={() => onSetAppearance(mode)}
                  size="sm"
                  variant={appearance === mode ? "default" : "secondary"}
                >
                  {mode.charAt(0).toUpperCase() + mode.slice(1)}
                </Button>
              ))}
            </div>
          </Section>
        </div>
      </aside>
    </div>
  );
}

function Section({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function ResourceView<T extends Array<unknown> | object>({
  resource, render, empty,
}: {
  resource: Resource<T>;
  render: (data: T) => React.ReactNode;
  empty?: React.ReactNode;
}) {
  if (resource.status === "loading") {
    return <p className="text-muted-foreground text-sm">Loading…</p>;
  }
  if (resource.status === "error") {
    return (
      <p className="text-muted-foreground text-sm">
        <span dangerouslySetInnerHTML={{ __html: "Couldn't load." }} />{" "}
        <button
          className="text-primary underline"
          onClick={() => resource.retry()}
          type="button"
        >
          Retry
        </button>
      </p>
    );
  }
  if (Array.isArray(resource.data) && resource.data.length === 0 && empty) {
    return <>{empty}</>;
  }
  return <>{render(resource.data)}</>;
}

function DaemonRow({
  daemon, onRename, onRevoke,
}: {
  daemon: DaemonItem;
  onRename: (daemon_id: string, display_name: string) => void;
  onRevoke: (daemon_id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(daemon.display_name ?? "");

  return (
    <div className="rounded-card border-border bg-surface shadow-card mb-2 border p-3">
      {editing ? (
        <div className="flex gap-2">
          <input
            autoFocus
            className="border-border bg-muted h-9 min-w-0 flex-1 rounded-md border px-3 text-sm outline-none"
            onChange={(e) => setDraft(e.target.value)}
            value={draft}
          />
          <Button onClick={() => { onRename(daemon.daemon_id, draft); setEditing(false); }} size="sm">
            Save
          </Button>
          <Button onClick={() => setEditing(false)} size="sm" variant="secondary">
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="flex items-center gap-2 truncate font-semibold">
              <StatusDot connected={daemon.connected} />
              {daemon.display_name ?? "(unnamed)"}
            </p>
            <p className="text-tertiary-foreground truncate font-mono text-[13px]">
              {daemon.daemon_id}
              {daemon.hostname ? ` @ ${daemon.hostname}` : ""}
            </p>
            <p className="text-muted-foreground text-xs" title={daemon.last_seen_at ? new Date(daemon.last_seen_at).toLocaleString() : ""}>
              {statusLabel(daemon)}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button onClick={() => setEditing(true)} size="sm" variant="secondary">
              Rename
            </Button>
            <Button
              onClick={() => {
                if (confirm("Revoke this daemon? It will be signed out.")) onRevoke(daemon.daemon_id);
              }}
              size="sm"
              variant="secondary"
            >
              Revoke
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusDot({ connected }: { connected: boolean }) {
  return (
    <span
      aria-label={connected ? "online" : "offline"}
      className={cn("inline-block size-2 rounded-full", connected ? "bg-success" : "bg-muted-foreground")}
    />
  );
}

function statusLabel(d: DaemonItem): string {
  if (d.connected) return "Online";
  if (d.last_seen_at == null) return "Never connected";
  const ageSec = Math.floor((Date.now() - d.last_seen_at) / 1000);
  if (ageSec < 30) return "Just now";
  return `Last seen ${formatRelative(ageSec)}`;
}

function formatRelative(sec: number): string {
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function PairCodeBox({
  pairing, onGenerate, onCancel, error,
}: {
  pairing: PairingState;
  onGenerate: () => void;
  onCancel: () => void;
  error: string | null;
}) {
  return (
    <div className="rounded-card border-border bg-muted border p-4 text-center">
      <p className="text-muted-foreground text-sm">Pairing code</p>
      <p className="mt-3 font-mono text-2xl font-semibold">
        {pairing.status === "active" ? pairing.code : "— —"}
      </p>
      {pairing.status === "idle" && (
        <>
          <Button className="mt-3" onClick={onGenerate} size="sm">
            Generate code
          </Button>
          <p className="text-muted-foreground mt-2 text-xs">
            Run cc-remote pair on your machine
          </p>
        </>
      )}
      {pairing.status === "issuing" && (
        <Button className="mt-3" disabled size="sm">
          Generating…
        </Button>
      )}
      {pairing.status === "active" && (
        <>
          <Button
            className="mt-3"
            onClick={() => copyCommand(`cc-remote pair ${pairing.code}`)}
            size="sm"
            variant="secondary"
          >
            <Copy className="size-4" />
            Copy "cc-remote pair {pairing.code}"
          </Button>
          <p className="text-muted-foreground mt-2 text-xs">
            Expires in {formatCountdown(pairing.remainingSec)}{" "}
            <button className="text-primary underline" onClick={onCancel} type="button">
              Cancel
            </button>
          </p>
        </>
      )}
      {error && <p className="text-danger mt-2 text-sm">{error}</p>}
    </div>
  );
}

function ToggleRow({
  enabled, label, onToggle,
}: {
  enabled: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      className="rounded-card border-border bg-surface shadow-card mb-2 flex w-full items-center justify-between border p-3 text-left"
      onClick={onToggle}
      type="button"
    >
      <span className="text-sm">{label}</span>
      <span
        className={cn(
          "rounded-full px-2 py-1 text-xs font-semibold",
          enabled ? "bg-success-subtle text-success" : "bg-muted text-muted-foreground",
        )}
      >
        {enabled ? "On" : "Off"}
      </span>
    </button>
  );
}

function formatCountdown(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function copyCommand(cmd: string) {
  if (typeof navigator !== "undefined" && navigator.clipboard) {
    navigator.clipboard.writeText(cmd).catch(() => {});
  }
}

function DndBlock({ dnd, onSave }: { dnd: DndSettings; onSave: (d: DndSettings) => Promise<void> }) {
  const [draft, setDraft] = useState<DndSettings>(dnd);
  const tz = draft.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <div className="rounded-card border-border bg-surface shadow-card mb-3 border p-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Do not disturb</span>
        <button
          className={cn(
            "rounded-full px-2 py-1 text-xs font-semibold",
            draft.enabled ? "bg-success-subtle text-success" : "bg-muted text-muted-foreground",
          )}
          onClick={() => {
            const next = {
              ...draft,
              enabled: !draft.enabled,
              start_hh_mm: draft.start_hh_mm ?? "22:00",
              end_hh_mm: draft.end_hh_mm ?? "07:00",
              timezone: draft.timezone ?? tz,
            };
            setDraft(next);
            void onSave(next);
          }}
          type="button"
        >
          {draft.enabled ? "On" : "Off"}
        </button>
      </div>
      {draft.enabled && (
        <div className="mt-3 grid grid-cols-3 gap-2">
          <label className="text-xs">Start
            <input
              type="time"
              className="border-border bg-muted mt-1 w-full rounded-md border px-2 py-1 text-sm"
              value={draft.start_hh_mm ?? ""}
              onChange={(e) => setDraft({ ...draft, start_hh_mm: e.target.value })}
            />
          </label>
          <label className="text-xs">End
            <input
              type="time"
              className="border-border bg-muted mt-1 w-full rounded-md border px-2 py-1 text-sm"
              value={draft.end_hh_mm ?? ""}
              onChange={(e) => setDraft({ ...draft, end_hh_mm: e.target.value })}
            />
          </label>
          <label className="text-xs">Timezone
            <input
              type="text"
              className="border-border bg-muted mt-1 w-full rounded-md border px-2 py-1 text-xs font-mono"
              value={draft.timezone ?? tz}
              onChange={(e) => setDraft({ ...draft, timezone: e.target.value })}
            />
          </label>
          <Button size="sm" className="col-span-3" onClick={() => void onSave(draft)}>Save DND</Button>
        </div>
      )}
    </div>
  );
}

function DefaultsBlock({
  state, onSetSub,
}: {
  state: PushTopicsState;
  onSetSub: (topic_id: string, daemon_id: string | null, enabled: boolean) => Promise<void>;
}) {
  return (
    <div className="mb-3">
      <p className="text-muted-foreground mb-2 text-xs uppercase">Defaults</p>
      {state.topics.map((t) => {
        const enabled = resolveSubscription(state.topics, state.subscriptions, t.id, "");
        return (
          <ToggleRow
            key={t.id}
            enabled={enabled}
            label={t.title}
            onToggle={() => void onSetSub(t.id, null, !enabled)}
          />
        );
      })}
    </div>
  );
}

function PerDaemonBlock({
  state, daemons, onSetSub, onResetDaemon,
}: {
  state: PushTopicsState;
  daemons: Resource<DaemonItem[]>;
  onSetSub: (topic_id: string, daemon_id: string | null, enabled: boolean) => Promise<void>;
  onResetDaemon: (daemon_id: string) => Promise<void>;
}) {
  if (daemons.status !== "ready" || daemons.data.length === 0) return null;
  return (
    <div>
      <p className="text-muted-foreground mb-2 text-xs uppercase">Per-daemon overrides</p>
      {daemons.data.map((d) => (
        <DaemonOverrideRow
          key={d.daemon_id}
          daemon={d}
          state={state}
          onSetSub={onSetSub}
          onResetDaemon={onResetDaemon}
        />
      ))}
    </div>
  );
}

function DaemonOverrideRow({
  daemon, state, onSetSub, onResetDaemon,
}: {
  daemon: DaemonItem;
  state: PushTopicsState;
  onSetSub: (topic_id: string, daemon_id: string | null, enabled: boolean) => Promise<void>;
  onResetDaemon: (daemon_id: string) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasOverrides = state.subscriptions.some((s) => s.daemon_id === daemon.daemon_id);

  return (
    <div className="rounded-card border-border bg-surface shadow-card mb-2 border p-3">
      <div className="flex items-center justify-between">
        <span className="truncate text-sm font-medium">{daemon.display_name ?? daemon.daemon_id}</span>
        <Button size="sm" variant="secondary" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Collapse" : `Override${hasOverrides ? " ✓" : ""}`}
        </Button>
      </div>
      {expanded && (
        <div className="mt-3">
          {state.topics.map((t) => {
            const enabled = resolveSubscription(state.topics, state.subscriptions, t.id, daemon.daemon_id);
            return (
              <ToggleRow
                key={t.id}
                enabled={enabled}
                label={t.title}
                onToggle={() => void onSetSub(t.id, daemon.daemon_id, !enabled)}
              />
            );
          })}
          <Button size="sm" variant="secondary" onClick={() => void onResetDaemon(daemon.daemon_id)}>
            Reset to defaults
          </Button>
        </div>
      )}
    </div>
  );
}
