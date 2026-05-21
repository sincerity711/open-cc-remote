# PWA Integration P5 — Settings + Auth + Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the final three milestones — `SettingsDrawer` replaces `Settings.tsx`, `SignInScreen` replaces the inline not-signed-in branch (with a 3-consecutive-401 bearer-clear guard), and the cleanup pass removes orphaned files (`SessionPane.tsx`, old `Settings.tsx`) and renames `ws.ts` / `auth.ts` / `api.ts` into the `hooks/` directory per the spec layout. After P5 the live `/` route is fully prototype-styled, the `screens/` layer is presentational only, and `App.tsx` is a 12-line router.

**Architecture:** Two new presentational screens (`SettingsDrawer`, `SignInScreen`) are pure props. Two thin data hooks (`useDevices`, `usePushPrefs`) wrap the existing fetch calls so the drawer's state lives in a hook RealApp composes — not inside the screen. The auth-failure guard counts consecutive WS opens that close before any frame arrives; on the third, it clears the bearer and stops reconnecting (per spec §3.5). The cleanup pass is mechanical: delete two orphan files, move three files into `hooks/`, fix imports.

**Tech Stack:** React 18, TypeScript strict, Tailwind 4, lucide-react, shadcn `Button`. No new dependencies.

**Reference:** Source spec — `docs/superpowers/specs/2026-05-21-pwa-prototype-integration-design.md` §1 directory layout, §2.4 SettingsDrawer prop shape, §2.5 pairing UI placeholder, §3.5 IAS auth fallbacks, §3.6 push notifications, §4 milestones M7 + M8 + M9.

**Prerequisite:** P1 + P2 + P3 + P4 complete. `screens/AppShell`, `screens/HomeScreen`, `screens/SessionView`, `screens/PermissionSurface` all wired into `RealApp`. `PermissionBanner.tsx` already deleted. `Settings.tsx` and `SessionPane.tsx` still on disk; `ws.ts`, `auth.ts`, `api.ts` still at the `src/` root.

---

## File structure after P5

```
packages/pwa/src/
├── App.tsx                            # MODIFIED — final shape: 12-line router (no logic change vs P1)
├── components/ui/button.tsx           # unchanged
├── demo/DemoApp.tsx                   # unchanged (imports updated in Task 9 only if needed)
├── hooks/
│   ├── useAuth.ts                     # NEW — wraps consumeFragment/getBearer/clearBearer/loginUrl
│   ├── useDevices.ts                  # NEW — wraps the device + push API
│   ├── useHub.ts                      # MOVED from src/ws.ts (no logic change)
│   ├── useMediaQuery.ts               # exists (P4)
│   ├── usePermissionQueue.ts          # exists (P4)
│   └── useSessionTimeline.ts          # exists (P3)
├── lib/
│   ├── daemonViewModel.ts             # exists (P4)
│   ├── timeline.ts                    # exists (P3)
│   └── utils.ts                       # unchanged
├── main.tsx                           # unchanged
├── push.ts                            # unchanged
├── RealApp.tsx                        # MODIFIED — uses SettingsDrawer + SignInScreen + new import paths
├── screens/
│   ├── AppShell.tsx                   # exists (P4)
│   ├── HomeScreen.tsx                 # exists (P4)
│   ├── PermissionSurface.tsx          # exists (P4)
│   ├── SessionView.tsx                # exists (P3)
│   ├── SettingsDrawer.tsx             # NEW
│   ├── SignInScreen.tsx               # NEW
│   ├── primitives/                    # exists (P1)
│   └── timeline/                      # exists (P2/P3)
└── styles.css                         # unchanged

DELETED in P5:
  src/SessionPane.tsx
  src/Settings.tsx
  src/ws.ts        (moved → hooks/useHub.ts)
  src/auth.ts      (moved → hooks/useAuth.ts)
  src/api.ts       (moved → hooks/useDevices.ts)
```

---

## Task 1: Data hooks — `hooks/useDevices.ts`

**Why:** `screens/SettingsDrawer.tsx` is presentational; the device list, the loading/error state, the rename / revoke calls, and the push-preferences toggles must live in a hook. Wrapping the existing `api.ts` functions here also nails the M9 file-move target — at the end of P5 the rename `api.ts → hooks/useDevices.ts` is just a `git mv` because the new module is the canonical home.

**Files:**
- Create: `packages/pwa/src/hooks/useDevices.ts`

- [ ] **Step 1: Create the hook**

Create `packages/pwa/src/hooks/useDevices.ts`:

```ts
import { useCallback, useEffect, useState } from "react";
import {
  getPushPreferences,
  listDevices,
  renameDevice,
  revokeDevice,
  setPushPreferences,
  type DeviceItem,
  type PushPreferences,
} from "../api";

export type { DeviceItem, PushPreferences };

export interface UseDevicesResult {
  devices: DeviceItem[] | null;
  pushPrefs: PushPreferences | null;
  error: string | null;
  refresh: () => void;
  rename: (device_id: string, display_name: string) => Promise<void>;
  revoke: (device_id: string) => Promise<void>;
  togglePushPref: (key: keyof PushPreferences) => Promise<void>;
}

const PREF_DEFAULT_TRUE: ReadonlyArray<keyof PushPreferences> = ["permission"];

function isEnabled(prefs: PushPreferences, key: keyof PushPreferences): boolean {
  if (PREF_DEFAULT_TRUE.includes(key)) return prefs[key] !== false;
  return prefs[key] === true;
}

/**
 * Wraps the existing fetch helpers in a hook so screens stay presentational.
 * Treats network errors the same as the legacy Settings.tsx — exposes the message
 * via `error`; doesn't retry. SettingsDrawer surfaces it inline.
 */
export function useDevices(hubUrl: string, bearer: string | null): UseDevicesResult {
  const [devices, setDevices] = useState<DeviceItem[] | null>(null);
  const [pushPrefs, setPushPrefs] = useState<PushPreferences | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (!bearer) return;
    listDevices(hubUrl, bearer).then(setDevices).catch((e) => setError((e as Error).message));
  }, [hubUrl, bearer]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!bearer) return;
    getPushPreferences(hubUrl, bearer)
      .then(setPushPrefs)
      .catch((e) => setError((e as Error).message));
  }, [hubUrl, bearer]);

  const rename = useCallback(
    async (device_id: string, display_name: string) => {
      if (!bearer) return;
      try {
        await renameDevice(hubUrl, bearer, device_id, display_name);
        refresh();
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [hubUrl, bearer, refresh],
  );

  const revoke = useCallback(
    async (device_id: string) => {
      if (!bearer) return;
      try {
        await revokeDevice(hubUrl, bearer, device_id);
        refresh();
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [hubUrl, bearer, refresh],
  );

  const togglePushPref = useCallback(
    async (key: keyof PushPreferences) => {
      if (!bearer || !pushPrefs) return;
      const next: PushPreferences = { ...pushPrefs, [key]: !isEnabled(pushPrefs, key) };
      setPushPrefs(next);
      try {
        await setPushPreferences(hubUrl, bearer, next);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [hubUrl, bearer, pushPrefs],
  );

  return { devices, pushPrefs, error, refresh, rename, revoke, togglePushPref };
}

export { isEnabled as isPushPrefEnabled };
```

(Body distilled from `Settings.tsx` lines 14–96. Defaults match the legacy semantics: `permission` defaults on; `offline` / `completed` / `idle` default off.)

- [ ] **Step 2: Verify typecheck**

```bash
cd packages/pwa && bun run typecheck
```
Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add packages/pwa/src/hooks/useDevices.ts
git commit -m "feat(pwa): useDevices hook (devices + push prefs)"
```

---

## Task 2: `screens/SettingsDrawer.tsx` — presentational drawer

**Why:** Replaces `Settings.tsx` with the prototype's drawer markup driven by props from `useDevices`. Per spec §2.4 it's pure props: account email + signOut, devices + rename/revoke, push prefs + toggle, optional pairing code (always `undefined` in v1 per §2.5), appearance tri-state. Per spec §2.5 the pairing section is a UI placeholder with a "Run cc-remote pair" hint and a Copy command button — no hub call.

**Files:**
- Create: `packages/pwa/src/screens/SettingsDrawer.tsx`

- [ ] **Step 1: Implement the drawer**

Create `packages/pwa/src/screens/SettingsDrawer.tsx`:

```tsx
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
                  {mode[0].toUpperCase() + mode.slice(1)}
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
```

Note on `variant="default"`: matches the existing prototype `Button` default variant. If the local `Button` typing rejects it, look at `components/ui/button.tsx` and pick whichever name is the primary variant.

- [ ] **Step 2: Add a static-markup smoke test**

Create `packages/pwa/tests/SettingsDrawer.test.tsx`:

```tsx
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DeviceItem } from "../src/hooks/useDevices";
import { SettingsDrawer } from "../src/screens/SettingsDrawer";

const devices: DeviceItem[] = [
  { device_id: "dev-1", display_name: "MacBook", paired_at: 0, last_seen_at: 0 },
  { device_id: "dev-2", display_name: null, paired_at: 0, last_seen_at: null },
];

test("SettingsDrawer renders all five sections with live data", () => {
  const markup = renderToStaticMarkup(
    <SettingsDrawer
      device="desktop"
      account={{ email: "alice@example.com", onSignOut: () => {} }}
      devices={devices}
      onRenameDevice={() => {}}
      onRevokeDevice={() => {}}
      pushPrefs={{ permission: true, offline: false, completed: true, idle: false }}
      onTogglePref={() => {}}
      appearance="system"
      onSetAppearance={() => {}}
      error={null}
      onClose={() => {}}
    />,
  );

  expect(markup).toContain("alice@example.com");
  expect(markup).toContain("MacBook");
  expect(markup).toContain("(unnamed)");
  expect(markup).toContain("Permission alerts");
  expect(markup).toContain("Daemon offline");
  expect(markup).toContain("Claude finished a turn");
  expect(markup).toContain("Claude is idle");
  // Permission default-on + completed=true → two On chips.
  expect((markup.match(/>On</g) ?? []).length).toBe(2);
  expect((markup.match(/>Off</g) ?? []).length).toBe(2);
  expect(markup).toContain("Run cc-remote pair on your machine");
  expect(markup).toContain("Copy command");
});

test("SettingsDrawer surfaces error inline", () => {
  const markup = renderToStaticMarkup(
    <SettingsDrawer
      device="mobile"
      account={{ email: "x@y", onSignOut: () => {} }}
      devices={null}
      onRenameDevice={() => {}}
      onRevokeDevice={() => {}}
      pushPrefs={null}
      onTogglePref={() => {}}
      appearance="light"
      onSetAppearance={() => {}}
      error="failed to fetch devices"
      onClose={() => {}}
    />,
  );
  expect(markup).toContain("failed to fetch devices");
});
```

- [ ] **Step 3: Run typecheck and tests**

```bash
cd packages/pwa && bun run typecheck && bun test tests/SettingsDrawer.test.tsx
```
Expected: typecheck clean; 2 pass.

- [ ] **Step 4: Commit**

```bash
git add packages/pwa/src/screens/SettingsDrawer.tsx packages/pwa/tests/SettingsDrawer.test.tsx
git commit -m "feat(pwa): SettingsDrawer presentational drawer"
```

---

## Task 3: Wire `SettingsDrawer` into `RealApp` and delete `Settings.tsx`

**Why:** Final M7 step. Swap the inline `<Settings>` mount for `<SettingsDrawer>` driven by `useDevices`, then delete the legacy file.

**Files:**
- Modify: `packages/pwa/src/RealApp.tsx`
- Delete: `packages/pwa/src/Settings.tsx`

- [ ] **Step 1: Replace the imports and mount**

In `packages/pwa/src/RealApp.tsx`:

```diff
-import { Settings } from "./Settings.tsx";
+import { SettingsDrawer, type Appearance } from "./screens/SettingsDrawer";
+import { useDevices } from "./hooks/useDevices";
```

Inside `RealApp()`, alongside the existing hook calls:

```ts
const deviceData = useDevices(HUB_URL, bearer);
const [appearance, setAppearance] = useState<Appearance>("system");
```

Replace the `{showSettings && bearer && (<Settings …/>)}` block with:

```tsx
{showSettings && bearer && (
  <SettingsDrawer
    device={device}
    account={{
      email: getEmailFromBearer(bearer) ?? "signed in",
      onSignOut: () => {
        clearBearer();
        setBearer(null);
        setShowSettings(false);
      },
    }}
    devices={deviceData.devices}
    onRenameDevice={(id, name) => { void deviceData.rename(id, name); }}
    onRevokeDevice={(id) => { void deviceData.revoke(id); }}
    pushPrefs={deviceData.pushPrefs}
    onTogglePref={(key) => { void deviceData.togglePushPref(key); }}
    appearance={appearance}
    onSetAppearance={setAppearance}
    error={deviceData.error}
    onClose={() => setShowSettings(false)}
  />
)}
```

Add a tiny helper at the bottom of `RealApp.tsx` (or above the export):

```ts
function getEmailFromBearer(bearer: string): string | null {
  // Bearer is a JWT. Decode the email claim defensively — never throw.
  try {
    const payload = bearer.split(".")[1];
    if (!payload) return null;
    const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    if (typeof json.email === "string") return json.email;
    if (typeof json.sub === "string") return json.sub;
    return null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Verify typecheck and tests**

```bash
bun run typecheck
bun test packages/
```
Expected: all green.

- [ ] **Step 3: Manual settings smoke**

`cd packages/pwa && bun run dev`. Sign in. Open Settings via the gear icon (header on mobile/tablet, gear or nav-rail icon on desktop). Verify:

- Account section shows your email.
- Paired devices loads and lists at least one device. Rename + Revoke work end-to-end (revoke confirms, then list refreshes).
- Notifications: 4 toggles flip On/Off and persist across drawer close/reopen.
- Pair new daemon: shows `— —` with the "Run cc-remote pair on your machine" hint.
- Appearance tri-state highlights the selected mode (no persistence in v1 — that's an explicit follow-up per spec §4.3).
- Backdrop click + X button both close the drawer.

Stop the dev server.

- [ ] **Step 4: Delete the legacy file**

```bash
rm packages/pwa/src/Settings.tsx
```

Verify nothing else imports it:

```bash
grep -r 'from "./Settings"' packages/pwa/src
grep -r 'from "../Settings"' packages/pwa/src
```
Expected: zero matches.

- [ ] **Step 5: Final typecheck after deletion**

```bash
bun run typecheck
```
Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add packages/pwa/src/RealApp.tsx packages/pwa/src/Settings.tsx
git commit -m "feat(pwa): RealApp uses SettingsDrawer; delete legacy Settings.tsx (M7)"
```

---

## Task 4: `screens/SignInScreen.tsx`

**Why:** Replaces the inline-styled "You're not signed in." block in `RealApp.tsx`. Pure presentational — accepts `loginUrl` and renders a centered card with the brand mark and a CTA. The hook-side bearer check stays in RealApp.

**Files:**
- Create: `packages/pwa/src/screens/SignInScreen.tsx`

- [ ] **Step 1: Implement the screen**

Create `packages/pwa/src/screens/SignInScreen.tsx`:

```tsx
import { Button } from "../components/ui/button";
import { ClaudeCodeMark } from "./primitives/ClaudeCodeMark";

export interface SignInScreenProps {
  /** Absolute URL to the IAS login endpoint, produced by `loginUrl(HUB_URL)`. */
  loginHref: string;
  /** Optional banner shown above the CTA — e.g. "Session expired, please sign in again". */
  notice?: string;
}

export function SignInScreen({ loginHref, notice }: SignInScreenProps) {
  return (
    <main
      className="bg-background flex h-dvh items-center justify-center p-6"
      data-testid="sign-in-screen"
    >
      <div className="border-border bg-surface shadow-card flex w-full max-w-sm flex-col items-center rounded-2xl border p-6 text-center">
        <ClaudeCodeMark size="xl" />
        <h1 className="mt-4 text-2xl font-semibold">cc-remote</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Sign in with your hub account to control daemons remotely.
        </p>
        {notice && (
          <div
            className="bg-warning-subtle text-warning mt-4 w-full rounded-md px-3 py-2 text-xs"
            role="status"
          >
            {notice}
          </div>
        )}
        <Button asChild className="mt-5 w-full" size="lg">
          <a href={loginHref}>Sign in</a>
        </Button>
      </div>
    </main>
  );
}
```

If the local `Button` doesn't support `asChild` (Radix slot pattern), substitute:

```tsx
<a className="bg-primary text-primary-foreground mt-5 inline-flex h-11 w-full items-center justify-center rounded-md text-sm font-semibold" href={loginHref}>
  Sign in
</a>
```

- [ ] **Step 2: Add a static-markup smoke test**

Create `packages/pwa/tests/SignInScreen.test.tsx`:

```tsx
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SignInScreen } from "../src/screens/SignInScreen";

test("SignInScreen renders brand, CTA href, and optional notice", () => {
  const markup = renderToStaticMarkup(
    <SignInScreen loginHref="https://hub.example/auth/login" notice="Session expired" />,
  );
  expect(markup).toContain("cc-remote");
  expect(markup).toContain('href="https://hub.example/auth/login"');
  expect(markup).toContain("Session expired");
  expect(markup).toContain('data-testid="sign-in-screen"');
});

test("SignInScreen omits notice block when absent", () => {
  const markup = renderToStaticMarkup(
    <SignInScreen loginHref="https://hub.example/auth/login" />,
  );
  expect(markup).not.toContain('role="status"');
});
```

- [ ] **Step 3: Run typecheck and tests**

```bash
cd packages/pwa && bun run typecheck && bun test tests/SignInScreen.test.tsx
```
Expected: typecheck clean; 2 pass.

- [ ] **Step 4: Commit**

```bash
git add packages/pwa/src/screens/SignInScreen.tsx packages/pwa/tests/SignInScreen.test.tsx
git commit -m "feat(pwa): SignInScreen presentational shell"
```

---

## Task 5: 3-consecutive-401 bearer-clear guard in `useHub`

**Why:** Per spec §3.5 a stale bearer can produce an infinite reconnect loop (open → close → backoff → open → close). Detect this and bail out: if 3 consecutive WS opens close immediately (no frame received), treat the bearer as expired — clear it and stop retrying. The next render lands on `<SignInScreen>` with a "Session expired" notice.

**Files:**
- Modify: `packages/pwa/src/ws.ts`
- Modify: `packages/pwa/src/RealApp.tsx`

- [ ] **Step 1: Extend `useHub` with an `onAuthFailure` callback**

In `packages/pwa/src/ws.ts`:

1. Add an optional callback parameter:

```diff
-export function useHub(hubUrl: string, bearer: string | null): UseHubResult {
+export function useHub(
+  hubUrl: string,
+  bearer: string | null,
+  options?: { onAuthFailure?: () => void },
+): UseHubResult {
```

2. Track consecutive zero-frame closes inside the effect closure. Inside the WebSocket setup, replace the existing `connect`-and-reconnect logic so that:

- A new local `framelessOpens` counter starts at 0.
- `ws.onopen` does **not** reset the counter (we wait until a frame is observed).
- On `ws.onmessage`: reset `framelessOpens = 0` (proof of life).
- On `ws.onclose` reconnect path: if no frame was ever observed for the just-closed `ws`, increment `framelessOpens`. When it reaches 3, call `options?.onAuthFailure?.()`, stop reconnecting (`stopped = true`), and return.

Concretely the diff inside the `useEffect` body:

```diff
     let epoch = 0;
+    let framelessOpens = 0;
     const connect = () => {
       if (stopped) return;
       const myEpoch = ++epoch;
+      let receivedAnyFrame = false;
       ...
       ws.onopen = () => { ... };
       ws.onmessage = (ev) => {
         if (wsRef.current !== ws) return;
+        receivedAnyFrame = true;
+        framelessOpens = 0;
         try { apply(JSON.parse(ev.data) as HubToPwa); } catch {}
       };
       const reconnect = () => {
         if (wsRef.current === ws) {
           wsRef.current = null;
           setState((s) => ({ ...s, connected: false }));
         }
         if (stopped) return;
         if (myEpoch !== epoch) return;
+        if (!receivedAnyFrame) {
+          framelessOpens += 1;
+          if (framelessOpens >= 3) {
+            stopped = true;
+            options?.onAuthFailure?.();
+            return;
+          }
+        } else {
+          framelessOpens = 0;
+        }
         const delay = backoff;
         backoff = Math.min(backoff * 2, 10_000);
         setTimeout(connect, delay);
       };
```

(Note: this is a heuristic — a healthy hub that subscribes immediately and emits a `snapshot` frame on open will reset the counter. A stale bearer is rejected by the hub at handshake and the WS closes before any frame arrives. Three frameless cycles is the cutoff per spec.)

- [ ] **Step 2: Wire the callback in `RealApp.tsx`**

```diff
-const hub = useHub(HUB_URL, bearer);
+const [authNotice, setAuthNotice] = useState<string | null>(null);
+const hub = useHub(HUB_URL, bearer, {
+  onAuthFailure: () => {
+    clearBearer();
+    setBearer(null);
+    setAuthNotice("Session expired, please sign in again.");
+  },
+});
```

- [ ] **Step 3: Replace the inline not-signed-in branch with `<SignInScreen>`**

In `packages/pwa/src/RealApp.tsx`:

```diff
-import { consumeFragment, getBearer, loginUrl, clearBearer } from "./auth.ts";
+import { consumeFragment, getBearer, loginUrl, clearBearer } from "./auth.ts";
+import { SignInScreen } from "./screens/SignInScreen";

   if (!bearer) {
-    return (
-      <main style={{ fontFamily: "system-ui, sans-serif", padding: 24, maxWidth: 720 }}>
-        <h1 style={{ margin: 0 }}>cc-remote</h1>
-        <p style={{ color: "#666" }}>You're not signed in.</p>
-        <a href={loginUrl(HUB_URL)} ...>Sign in</a>
-      </main>
-    );
+    return <SignInScreen loginHref={loginUrl(HUB_URL)} notice={authNotice ?? undefined} />;
   }
```

After a successful sign-in (i.e. when `bearer` flips from null to a value), clear `authNotice`:

```ts
useEffect(() => {
  if (bearer) setAuthNotice(null);
}, [bearer]);
```

- [ ] **Step 4: Verify typecheck and tests**

```bash
bun run typecheck
bun test packages/
bun test e2e/
```
Expected: all green. The protocol-level e2e is unaffected — the guard only fires on auth-failure closes.

- [ ] **Step 5: Manual auth-failure smoke**

Two manual checks:

1. **Stale bearer clears bearing-removal:** From the dev console at `http://localhost:5173/`, run:

   ```js
   localStorage.setItem("cc_remote_bearer", "stale.junk.token");
   location.reload();
   ```

   Observe: the WS attempts, fails to subscribe, retries — after roughly 3 cycles the bearer is removed from localStorage and the page renders `<SignInScreen>` with the orange "Session expired, please sign in again." notice.

2. **Healthy bearer survives a long network blip:** Disconnect from the network for ~10 seconds, reconnect. The reconnect loop should resume without clearing the bearer (since no auth failure occurred — it was a transport-level close, not a frame-level rejection). On reconnect a `snapshot` frame arrives and resets the counter.

Stop the dev server.

- [ ] **Step 6: Commit**

```bash
git add packages/pwa/src/ws.ts packages/pwa/src/RealApp.tsx
git commit -m "feat(pwa): SignInScreen + 3-consecutive-401 bearer-clear guard (M8)"
```

---

## Task 6: Delete orphan `SessionPane.tsx`

**Why:** First step of M9 cleanup. After P3, `SessionPane.tsx` is unreferenced — RealApp uses `<SessionView>`. Confirm zero importers and delete.

**Files:**
- Delete: `packages/pwa/src/SessionPane.tsx`

- [ ] **Step 1: Verify no importers**

```bash
grep -rn 'from "./SessionPane' packages/pwa/src
grep -rn 'from "../SessionPane' packages/pwa/src
```
Expected: zero matches.

- [ ] **Step 2: Delete**

```bash
rm packages/pwa/src/SessionPane.tsx
```

- [ ] **Step 3: Verify typecheck and tests**

```bash
bun run typecheck
bun test packages/
bun test e2e/
```
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add packages/pwa/src/SessionPane.tsx
git commit -m "refactor(pwa): delete orphan SessionPane.tsx"
```

---

## Task 7: Move `ws.ts` → `hooks/useHub.ts`

**Why:** Second cleanup step. The file is already a hook with the canonical name; only its path changes. All importers update accordingly.

**Files:**
- Move: `packages/pwa/src/ws.ts` → `packages/pwa/src/hooks/useHub.ts`
- Modify: every importer.

- [ ] **Step 1: Move the file**

```bash
git mv packages/pwa/src/ws.ts packages/pwa/src/hooks/useHub.ts
```

- [ ] **Step 2: Update every import path**

Find all importers and update relative paths. Each importer changes by one `..` level depending on where it lives.

```bash
grep -rln 'from "[./]*ws"' packages/pwa/src packages/pwa/tests
grep -rln 'from "[./]*ws\.ts"' packages/pwa/src packages/pwa/tests
```

Expected importers (based on the codebase after P4):

- `packages/pwa/src/RealApp.tsx`: `from "./ws.ts"` → `from "./hooks/useHub"`
- `packages/pwa/src/lib/daemonViewModel.ts`: `from "../ws"` → `from "../hooks/useHub"`
- `packages/pwa/src/hooks/useSessionTimeline.ts`: `from "../ws"` → `from "./useHub"`

Update each one with Edit.

- [ ] **Step 3: Verify typecheck and tests**

```bash
bun run typecheck
bun test packages/
bun test e2e/
```
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add packages/pwa/src/hooks/useHub.ts packages/pwa/src/ws.ts \
        packages/pwa/src/RealApp.tsx \
        packages/pwa/src/lib/daemonViewModel.ts \
        packages/pwa/src/hooks/useSessionTimeline.ts
git commit -m "refactor(pwa): move ws.ts → hooks/useHub.ts"
```

---

## Task 8: Move `auth.ts` → `hooks/useAuth.ts` (with hook wrapper)

**Why:** Per spec the renamed module exposes a `useAuth` hook. Keep the existing low-level helpers (`consumeFragment`, `getBearer`, `clearBearer`, `loginUrl`) as named exports — they are still used by the auth-failure flow — and add a `useAuth(hubUrl)` hook that bundles the bearer state for callers that want it. RealApp adopts the hook to drop a few lines of boilerplate.

**Files:**
- Move: `packages/pwa/src/auth.ts` → `packages/pwa/src/hooks/useAuth.ts`
- Modify: `packages/pwa/src/RealApp.tsx`

- [ ] **Step 1: Move the file**

```bash
git mv packages/pwa/src/auth.ts packages/pwa/src/hooks/useAuth.ts
```

- [ ] **Step 2: Add the hook on top of the existing helpers**

Open `packages/pwa/src/hooks/useAuth.ts` and append (keep the existing five helpers untouched):

```ts
import { useEffect, useState } from "react";

export interface UseAuthResult {
  bearer: string | null;
  setBearer: (b: string | null) => void;
  signInHref: string;
  signOut: () => void;
}

export function useAuth(hubUrl: string): UseAuthResult {
  const [bearer, setBearer] = useState<string | null>(null);

  useEffect(() => {
    consumeFragment();
    setBearer(getBearer());
  }, []);

  return {
    bearer,
    setBearer,
    signInHref: loginUrl(hubUrl),
    signOut: () => {
      clearBearer();
      setBearer(null);
    },
  };
}
```

- [ ] **Step 3: Update `RealApp.tsx` to use the hook**

```diff
-import { consumeFragment, getBearer, loginUrl, clearBearer } from "./auth.ts";
-import { SignInScreen } from "./screens/SignInScreen";
+import { clearBearer, loginUrl, useAuth } from "./hooks/useAuth";
+import { SignInScreen } from "./screens/SignInScreen";

 export function RealApp() {
-  const [bearer, setBearer] = useState<string | null>(null);
+  const { bearer, setBearer, signInHref, signOut } = useAuth(HUB_URL);
   ...
-  useEffect(() => {
-    consumeFragment();
-    setBearer(getBearer());
-  }, []);
```

The auth-failure callback in `useHub` still needs `clearBearer`, so keep that import. Replace the manual sign-out in `SettingsDrawer` and the AppShell `onSignOut` to use the hook's `signOut`:

```diff
-onSignOut={() => { clearBearer(); setBearer(null); }}
+onSignOut={() => { signOut(); setShowSettings(false); }}
```

(Same for SettingsDrawer's account.onSignOut — call `signOut()`.)

Replace the `loginUrl(HUB_URL)` calls inside RealApp with `signInHref`:

```diff
-return <SignInScreen loginHref={loginUrl(HUB_URL)} notice={authNotice ?? undefined} />;
+return <SignInScreen loginHref={signInHref} notice={authNotice ?? undefined} />;
```

- [ ] **Step 4: Verify typecheck and tests**

```bash
bun run typecheck
bun test packages/
bun test e2e/
```
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add packages/pwa/src/hooks/useAuth.ts packages/pwa/src/auth.ts packages/pwa/src/RealApp.tsx
git commit -m "refactor(pwa): move auth.ts → hooks/useAuth.ts with useAuth wrapper"
```

---

## Task 9: Move `api.ts` → `hooks/useDevices.ts` (consolidate into the existing hook file)

**Why:** `useDevices.ts` (created in Task 1) currently imports its low-level helpers from `../api`. Inline them into the hook file so the rename is complete and `api.ts` disappears.

**Files:**
- Modify: `packages/pwa/src/hooks/useDevices.ts`
- Delete: `packages/pwa/src/api.ts`

- [ ] **Step 1: Inline `api.ts` into `hooks/useDevices.ts`**

Open `packages/pwa/src/hooks/useDevices.ts` and replace the top imports:

```diff
-import {
-  getPushPreferences,
-  listDevices,
-  renameDevice,
-  revokeDevice,
-  setPushPreferences,
-  type DeviceItem,
-  type PushPreferences,
-} from "../api";
```

With the contents of `api.ts` inlined (interfaces + helpers + the `httpHub` private helper). Keep these helpers as named exports so `push.ts` (which currently does **not** import from `api.ts` — confirm with `grep`) and any test files can use them.

After inlining the file should start with:

```ts
import { useCallback, useEffect, useState } from "react";

export interface DeviceItem {
  device_id: string;
  display_name: string | null;
  paired_at: number;
  last_seen_at: number | null;
}

export interface PushPreferences {
  permission?: boolean;
  offline?: boolean;
  completed?: boolean;
  idle?: boolean;
}

function httpHub(hubUrl: string): string {
  return hubUrl.replace(/^ws(s?):\/\//, "http$1://");
}

async function jsonFetch<T>(url: string, bearer: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { ...init.headers, authorization: `Bearer ${bearer}` },
  });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${url}: ${res.status}`);
  if (res.status === 204) return undefined as T;
  return await res.json() as T;
}

export async function listDevices(hubUrl: string, bearer: string): Promise<DeviceItem[]> {
  return jsonFetch<DeviceItem[]>(`${httpHub(hubUrl)}/devices`, bearer);
}

export async function renameDevice(
  hubUrl: string,
  bearer: string,
  device_id: string,
  display_name: string,
): Promise<void> {
  await jsonFetch<void>(`${httpHub(hubUrl)}/devices/${encodeURIComponent(device_id)}`, bearer, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ display_name }),
  });
}

export async function revokeDevice(
  hubUrl: string,
  bearer: string,
  device_id: string,
): Promise<void> {
  await jsonFetch<void>(`${httpHub(hubUrl)}/devices/${encodeURIComponent(device_id)}`, bearer, {
    method: "DELETE",
  });
}

export async function getPushPreferences(
  hubUrl: string,
  bearer: string,
): Promise<PushPreferences> {
  return jsonFetch<PushPreferences>(`${httpHub(hubUrl)}/push/preferences`, bearer);
}

export async function setPushPreferences(
  hubUrl: string,
  bearer: string,
  prefs: PushPreferences,
): Promise<void> {
  await jsonFetch<void>(`${httpHub(hubUrl)}/push/preferences`, bearer, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(prefs),
  });
}

// ... existing UseDevicesResult / useDevices / isPushPrefEnabled ...
```

(Drop the `from "../api"` import — everything it provided is now defined locally.)

- [ ] **Step 2: Delete the original file**

```bash
rm packages/pwa/src/api.ts
```

Verify nothing imports it:

```bash
grep -rn 'from "[./]*api"' packages/pwa/src packages/pwa/tests
grep -rn 'from "[./]*api\.ts"' packages/pwa/src packages/pwa/tests
```
Expected: zero matches.

- [ ] **Step 3: Verify typecheck and tests**

```bash
bun run typecheck
bun test packages/
bun test e2e/
```
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add packages/pwa/src/hooks/useDevices.ts packages/pwa/src/api.ts
git commit -m "refactor(pwa): inline api.ts into hooks/useDevices.ts; delete api.ts"
```

---

## Task 10: Final P5 verification

- [ ] **Step 1: Workspace-wide typecheck**

```bash
bun run typecheck
```
Expected: every package green.

- [ ] **Step 2: Workspace-wide unit tests**

```bash
bun test packages/
```
Expected: P4 baseline + 2 (SettingsDrawer) + 2 (SignInScreen) = previous + 4. All pass.

- [ ] **Step 3: In-process e2e**

```bash
bun test e2e/
```
Expected: all 12 in-process scenarios pass.

- [ ] **Step 4: Manual full-flow smoke on `/` and `/demo`**

Start `cd packages/pwa && bun run dev`:

- `/` → `<SignInScreen>` if no bearer; otherwise `<AppShell>` with `<HomeScreen>` + `<SessionView>` + `<PermissionSurface>` + `<SettingsDrawer>`. Walk through: sign in → daemon list → start a session → send chat → trigger a tool requiring permission → allow → finish a turn → settings → toggle a push pref → revoke a test device → sign out → land on SignInScreen.
- `/demo` → guided demo unchanged from earlier plans.

Verify on three breakpoints (mobile, tablet, desktop) at least once each.

Stop the dev server.

- [ ] **Step 5: Confirm directory layout matches spec**

```bash
find packages/pwa/src -maxdepth 2 -type f | sort
```

Expected: only the files listed in the "File structure after P5" section above. No `ws.ts`, `auth.ts`, `api.ts`, `SessionPane.tsx`, `Settings.tsx`, `PermissionBanner.tsx` at `src/` root.

- [ ] **Step 6: Confirm clean tree and tag the rollout**

```bash
git status
```
Expected: working tree clean.

```bash
git tag plan-pwa-prototype-integration
```

- [ ] **Step 7: Update `docs/TODO.md`**

Mark the PWA prototype integration as done. Open `docs/TODO.md`, find the row for this initiative, and check it off (or add a new completion line if there is no row yet — keep it short, one line).

- [ ] **Step 8: Commit the TODO update**

```bash
git add docs/TODO.md
git commit -m "docs: mark pwa-prototype-integration done"
```

P5 is done. The PWA prototype integration is complete: live `/` is fully prototype-styled across mobile / tablet / desktop, `/demo` remains as the regression baseline, and the `screens/` layer is presentational only.
