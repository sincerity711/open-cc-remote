import { useState } from "react";
import { Copy, X } from "lucide-react";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import type { Device } from "../hooks/useMediaQuery";
import type { DeviceItem, PushPreferences } from "../hooks/useDevices";
import { isPushPrefEnabled } from "../hooks/useDevices";

export type Appearance = "system" | "light" | "dark";

export interface PushToggleSpec {
  key: keyof PushPreferences;
  label: string;
}

const PUSH_TOGGLES: ReadonlyArray<PushToggleSpec> = [
  { key: "permission", label: "Permission alerts" },
  { key: "offline", label: "Daemon offline (≥ 30s)" },
  { key: "completed", label: "Claude finished a turn" },
  { key: "idle", label: "Claude is idle" },
];

export interface SettingsDrawerProps {
  device: Device;
  account: { email: string; onSignOut: () => void };
  devices: DeviceItem[] | null;
  onRenameDevice: (device_id: string, display_name: string) => void;
  onRevokeDevice: (device_id: string) => void;
  pushPrefs: PushPreferences | null;
  onTogglePref: (key: keyof PushPreferences) => void;
  /** v1: always undefined. Reserved for future hub-side pairing. */
  pairingCode?: { code: string; expiresInSec: number };
  appearance: Appearance;
  onSetAppearance: (mode: Appearance) => void;
  error: string | null;
  onClose: () => void;
}

export function SettingsDrawer({
  device,
  account,
  devices,
  onRenameDevice,
  onRevokeDevice,
  pushPrefs,
  onTogglePref,
  pairingCode,
  appearance,
  onSetAppearance,
  error,
  onClose,
}: SettingsDrawerProps) {
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

        {error && (
          <div className="bg-danger-subtle text-danger mt-4 rounded-md px-3 py-2 text-sm">
            {error}
          </div>
        )}

        <div className="mt-5 space-y-5">
          <Section title="Account">
            <p className="text-muted-foreground text-sm">{account.email}</p>
            <Button className="mt-3" onClick={account.onSignOut} size="sm" variant="secondary">
              Sign out
            </Button>
          </Section>

          <Section title="Paired devices">
            {devices === null ? (
              <p className="text-muted-foreground text-sm">Loading…</p>
            ) : devices.length === 0 ? (
              <p className="text-muted-foreground text-sm">No devices.</p>
            ) : (
              devices.map((d) => (
                <DeviceRow
                  key={d.device_id}
                  device={d}
                  onRename={onRenameDevice}
                  onRevoke={onRevokeDevice}
                />
              ))
            )}
          </Section>

          <Section title="Pair new daemon">
            <div className="rounded-card border-border bg-muted border p-4 text-center">
              <p className="text-muted-foreground text-sm">Pairing code</p>
              <p className="mt-3 font-mono text-2xl font-semibold">
                {pairingCode?.code ?? "— —"}
              </p>
              <p className="text-muted-foreground mt-2 text-xs">
                {pairingCode
                  ? `Expires in ${formatCountdown(pairingCode.expiresInSec)}`
                  : "Run cc-remote pair on your machine"}
              </p>
              <Button
                className="mt-3"
                onClick={() => copyCommand("cc-remote pair")}
                size="sm"
                variant="secondary"
              >
                <Copy className="size-4" />
                Copy command
              </Button>
            </div>
          </Section>

          <Section title="Notifications">
            {pushPrefs === null ? (
              <p className="text-muted-foreground text-sm">Loading…</p>
            ) : (
              PUSH_TOGGLES.map(({ key, label }) => (
                <ToggleRow
                  key={key}
                  enabled={isPushPrefEnabled(pushPrefs, key)}
                  label={label}
                  onToggle={() => onTogglePref(key)}
                />
              ))
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

function DeviceRow({
  device,
  onRename,
  onRevoke,
}: {
  device: DeviceItem;
  onRename: (device_id: string, display_name: string) => void;
  onRevoke: (device_id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(device.display_name ?? "");

  return (
    <div className="rounded-card border-border bg-surface mb-2 border p-3">
      {editing ? (
        <div className="flex gap-2">
          <input
            autoFocus
            className="border-border bg-muted h-9 min-w-0 flex-1 rounded-md border px-3 text-sm outline-none"
            onChange={(e) => setDraft(e.target.value)}
            value={draft}
          />
          <Button
            onClick={() => {
              onRename(device.device_id, draft);
              setEditing(false);
            }}
            size="sm"
          >
            Save
          </Button>
          <Button onClick={() => setEditing(false)} size="sm" variant="secondary">
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate font-semibold">{device.display_name ?? "(unnamed)"}</p>
            <p className="text-muted-foreground truncate font-mono text-xs">
              {device.device_id}
            </p>
            <p className="text-muted-foreground text-xs">
              paired {new Date(device.paired_at).toLocaleString()}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button onClick={() => setEditing(true)} size="sm" variant="secondary">
              Rename
            </Button>
            <Button
              onClick={() => {
                if (confirm("Revoke this device? It will be signed out everywhere.")) {
                  onRevoke(device.device_id);
                }
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

function ToggleRow({
  enabled,
  label,
  onToggle,
}: {
  enabled: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      className="rounded-card border-border bg-surface mb-2 flex w-full items-center justify-between border p-3 text-left"
      onClick={onToggle}
      type="button"
    >
      <span className="text-sm">{label}</span>
      <span
        className={cn(
          "rounded-full px-2 py-1 text-xs font-semibold",
          enabled
            ? "bg-success-subtle text-success"
            : "bg-muted text-muted-foreground",
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
