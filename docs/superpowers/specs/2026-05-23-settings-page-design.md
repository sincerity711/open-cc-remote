# Settings Page — Daemons, Pair Code, Tri-State Errors

Date: 2026-05-23
Status: Draft (post-brainstorming)
Related TODO: `docs/TODO.md` § "Settings page gaps (surfaced 2026-05-23)"

## 1. Problem

The PWA Settings drawer (`packages/pwa/src/screens/SettingsDrawer.tsx`) has three visible holes when used against a real hub:

1. **Wrong list.** The "Paired devices" section lists rows from the `devices` table (PWA browser sessions, IAS-auto-created on login). What the user expects to manage is the `daemons` table (machines paired explicitly by `cc-remote pair`). The section title and the adjacent "Pair new daemon" header confirm the original intent was daemons; the implementation is pointed at the wrong table.
2. **No pair-code feature.** `SettingsDrawer.tsx:32` hard-codes `pairingCode={undefined}` with a comment "v1: always undefined. Reserved for future hub-side pairing." The only way to mint a code today is `bun packages/hub/src/admin.ts issue-pairing-code <sub>` from inside the hub container. End users have no path.
3. **Loading/error tri-state is broken.** When `GET /devices` or `GET /push/preferences` fails, `useDevices.ts:90,101` sets `error` but never flips `devices`/`pushPrefs` from `null`. Result: a red "Failed to fetch" banner sits at the top while both sections show "Loading…" forever, with no retry.

This spec covers all three. **Out of scope:** reworking notifications to be channel-based (tracked separately in TODO.md as a protocol-level future spec); managing PWA browser sessions through the UI (no current need).

## 2. Goals

- A PWA-authenticated user can mint a short-lived pairing code from Settings, copy `cc-remote pair <code>`, and see the new daemon in the list after pairing.
- The "Paired daemons" section reflects machines, not browser sessions; each row shows online status (live WS or recent), allows rename and revoke.
- Each Settings section degrades independently on fetch failure: a section-local "Couldn't load. [Retry]" instead of a blocking top banner.
- Push notification subscriptions continue to work unchanged. The four hard-coded toggles (`permission / offline / completed / idle`) remain.

## 3. Non-Goals

- Channel-based notifications (separate spec).
- Listing/revoking PWA browser sessions in the UI.
- Real-time daemon status push (refresh-on-open + 60s poll while drawer open).
- QR code pairing UX.
- Daemon detail subpage.

## 4. Architecture

```
                  ┌─────────────────────────┐
                  │   PWA SettingsDrawer    │
                  │  ┌───────────────────┐  │
                  │  │  Account          │  │ ← unchanged
                  │  ├───────────────────┤  │
                  │  │  Paired daemons   │  │ ← NEW source: GET /daemons
                  │  ├───────────────────┤  │
                  │  │  Pair new daemon  │  │ ← NEW: POST /pair/issue
                  │  ├───────────────────┤  │
                  │  │  Notifications    │  │ ← unchanged backend
                  │  ├───────────────────┤  │
                  │  │  Appearance       │  │ ← unchanged (client-only)
                  │  └───────────────────┘  │
                  └────────────┬────────────┘
                               │ HTTPS (Bearer ccr_…)
              ┌────────────────┴───────────────────┐
              ▼                                    ▼
    ┌──────────────────┐               ┌────────────────────┐
    │  GET /daemons    │               │  POST /pair/issue  │
    │  PATCH /daemons/:│               │  (PWA-auth)        │
    │  DELETE /daemons/│               │  → 6-char code,    │
    │  (PWA-auth)      │               │    5min TTL        │
    └────────┬─────────┘               └─────────┬──────────┘
             │                                   │
             ▼                                   ▼
    ┌──────────────────┐               ┌────────────────────┐
    │ daemons repo     │               │ pairing_codes repo │
    │ + router live    │◀──────────────│  (existing)        │
    │   connected map  │               └────────────────────┘
    └──────────────────┘
```

### 4.1 Conceptual model

- **`devices`** = a PWA browser session. Created by IAS login. Bears the `ccr_…` token used by the PWA to call the hub. Owns push subscriptions (FK from `push_subs`). **Not user-managed.**
- **`daemons`** = a machine paired via `cc-remote pair`. Created on `POST /pair`. Bears a JWT used by the daemon to open `WS /ws/daemon`. **User-managed via Settings.**

The two are completely disjoint and remain so.

## 5. Backend changes

### 5.1 Schema migration

`daemons` table already has `paired_at`, `last_seen_at`, `revoked_at`. It is missing `display_name`.

Add migration `version: 2` to `packages/hub/src/schema.ts`:

```sql
ALTER TABLE daemons ADD COLUMN display_name TEXT;
```

### 5.2 Daemons repo

Add to `packages/hub/src/repos/daemons.ts`:

```ts
export interface DaemonListItem {
  daemon_id: string;
  display_name: string | null;
  hostname: string | null;
  paired_at: number;
  last_seen_at: number | null;
}

export function listDaemonsByOwner(db: Db, owner_sub: string): DaemonListItem[];
export function renameDaemon(db: Db, owner_sub: string, daemon_id: string, display_name: string): boolean;
export function revokeDaemonAuthorized(db: Db, owner_sub: string, daemon_id: string): boolean;
```

`renameDaemon` and `revokeDaemonAuthorized` mirror the existing `renameDevice` / `revokeDeviceAuthorized` helpers — `WHERE owner_sub = ? AND daemon_id = ? AND revoked_at IS NULL`, return whether the row matched.

`revokeDaemonAuthorized` must clear `jwt_jti` to invalidate any in-flight DPoP-bound JWT (existing `setJwtId(daemon_id, null, null)` already does this — call it after the UPDATE).

### 5.3 Router exposes connected set

`packages/hub/src/router.ts:28` already maintains `private daemons = new Map<string, DaemonState>()` for offline-push timing. Add:

```ts
public getConnectedDaemonIds(): Set<string> {
  return new Set(this.daemons.keys());
}

public closeDaemonConnection(daemon_id: string): void {
  const state = this.daemons.get(daemon_id);
  state?.ws.close(1008, "revoked");
}
```

### 5.4 Routes

Add to `packages/hub/src/routes.ts` (mirror existing `/devices` patterns):

| Method | Path             | Auth      | Body / Response                                                  |
|--------|------------------|-----------|-------------------------------------------------------------------|
| GET    | `/daemons`       | PWA       | `[{daemon_id, display_name, hostname, paired_at, last_seen_at, connected}]`. Sort: `connected=true` first, then `paired_at desc`. |
| PATCH  | `/daemons/:id`   | PWA       | `{display_name: string}` → 204 / 404                              |
| DELETE | `/daemons/:id`   | PWA       | 204 / 404. Side-effects: revoke + clear JTI + close WS.           |
| POST   | `/pair/issue`    | PWA       | `{}` → `{code, expires_in_sec}`. TTL = 5 min. Calls existing `issueCode(db, "daemon", auth.owner_sub, null, 300_000)`. |

`GET /daemons` reads daemons from DB then enriches with `connected = router.getConnectedDaemonIds().has(daemon_id)`. Router instance is accessible via the existing `opts` pattern; if not currently passed to routes, add it (one extra option field; no protocol change).

DELETE handler ordering:
1. `revokeDaemonAuthorized` (sets `revoked_at`, clears JTI)
2. `router.closeDaemonConnection(daemon_id)` (best-effort, ok if not connected)
3. Return 204

### 5.5 No new protocol frames

Daemon online state is read on demand via HTTP `/daemons`. No new WS frames between hub and PWA. No new frames between hub and daemon. `consumeCode` is unchanged — codes minted via `/pair/issue` flow through the existing `POST /pair` handler unmodified.

## 6. Frontend changes

### 6.1 Resource tri-state

Introduce a discriminated union in `packages/pwa/src/hooks/types.ts` (new file):

```ts
export type Resource<T> =
  | { status: "loading" }
  | { status: "error"; error: string; retry: () => void }
  | { status: "ready"; data: T };
```

### 6.2 New hooks

**`packages/pwa/src/hooks/useDaemons.ts`**

```ts
export interface DaemonItem {
  daemon_id: string;
  display_name: string | null;
  hostname: string | null;
  paired_at: number;
  last_seen_at: number | null;
  connected: boolean;
}

export function useDaemons(hubUrl: string, bearer: string | null): {
  daemons: Resource<DaemonItem[]>;
  rename: (id: string, name: string) => Promise<void>;
  revoke: (id: string) => Promise<void>;
  refresh: () => void;          // exposed for caller (e.g., usePairing on success)
  lastActionError: string | null;
};
```

Polls every 60 s while drawer open (caller mounts/unmounts the hook on drawer toggle).

**`packages/pwa/src/hooks/usePairing.ts`**

```ts
export type PairingState =
  | { status: "idle" }
  | { status: "issuing" }
  | { status: "active"; code: string; remainingSec: number };

export function usePairing(hubUrl: string, bearer: string | null, onPaired?: () => void): {
  state: PairingState;
  generate: () => Promise<void>;
  cancel: () => void;
  lastError: string | null;
};
```

- `generate()` → `POST /pair/issue` → on success enter `active` with countdown.
- 1 Hz timer ticks `remainingSec`. At 0 → back to `idle`.
- `cancel()` → set `idle` (does not invalidate the code server-side; TTL handles it).
- `onPaired` is wired by the caller to `useDaemons.refresh`. Since the PWA can't be told when a daemon consumes the code, the hook also calls `onPaired` once `remainingSec` hits zero (best-effort: pair likely happened during the window).

### 6.3 useDevices.ts changes

- Drop the device-list code path entirely (the `devices` / `setDevices` / `listDevices` exports are no longer consumed by the UI).
- Keep push prefs but expose them as `Resource<PushPreferences>`:

```ts
export function usePushPrefs(hubUrl: string, bearer: string | null): {
  prefs: Resource<PushPreferences>;
  toggle: (key: keyof PushPreferences) => Promise<void>;
  lastActionError: string | null;
};
```

The legacy `useDevices` symbol is replaced by `usePushPrefs` (rename file or split — implementer's call). Push subscribe/unsubscribe code in `push.ts` is unchanged; it operates on the *device* token, not on this hook's data.

### 6.4 SettingsDrawer.tsx

Props change:

```ts
export interface SettingsDrawerProps {
  device: Device;
  account: { email: string; onSignOut: () => void };
  daemons: Resource<DaemonItem[]>;
  onRenameDaemon: (id: string, name: string) => void;
  onRevokeDaemon: (id: string) => void;
  pushPrefs: Resource<PushPreferences>;
  onTogglePref: (key: keyof PushPreferences) => void;
  pairing: PairingState;
  onGenerateCode: () => void;
  onCancelPairing: () => void;
  appearance: Appearance;
  onSetAppearance: (mode: Appearance) => void;
  // Removed: error, pairingCode (legacy unused)
  onClose: () => void;
  // Optional last-action error strings for inline display:
  daemonActionError?: string | null;
  pushActionError?: string | null;
  pairingError?: string | null;
}
```

Each section renders by `status`:
- `loading` → `<p className="text-muted-foreground text-sm">Loading…</p>`
- `error` → `<p className="text-muted-foreground text-sm">Couldn't load. <button onClick={retry}>Retry</button></p>`
- `ready` → existing render (now keyed off `data`)

Top-level red banner (`error && <div className="bg-danger-subtle…">`) is removed. Per-action errors render inline under their action area as `<p className="text-danger text-sm">{lastActionError}</p>`.

### 6.5 Daemon row UI

```
┌────────────────────────────────────────────────────┐
│ 🟢 Work laptop              [Rename] [Revoke]     │
│    ws-laptop @ ciros-mbp                          │
│    Online · paired 3 days ago                     │
└────────────────────────────────────────────────────┘
```

Status string by rule:

| State                                           | Indicator | Text                              |
|-------------------------------------------------|-----------|-----------------------------------|
| `connected = true`                              | 🟢 green  | `Online`                          |
| `connected = false`, `last_seen_at` < 30 s ago  | ⚪ grey   | `Just now`                        |
| `connected = false`, `last_seen_at` ≥ 30 s ago  | ⚪ grey   | `Last seen <relative>`            |
| `last_seen_at = null`                           | ⚪ grey   | `Never connected`                 |

Tooltip on the timestamp shows absolute `Date.toLocaleString()` of `last_seen_at`.

### 6.6 Pair-code box

`idle`:
```
┌─────────────────────────────────────────────┐
│              Pairing code                   │
│                  — —                        │
│      [Generate code]                        │
│   Run cc-remote pair on your machine        │
└─────────────────────────────────────────────┘
```

`active`:
```
┌─────────────────────────────────────────────┐
│              Pairing code                   │
│                ABC-XYZ                      │
│    [Copy "cc-remote pair ABC-XYZ"]          │
│           Expires in 4:23  [Cancel]         │
└─────────────────────────────────────────────┘
```

`issuing`:
```
┌─────────────────────────────────────────────┐
│              Pairing code                   │
│                  — —                        │
│      [Generating…]   (disabled)             │
└─────────────────────────────────────────────┘
```

Copy command literal: `` `cc-remote pair ${code}` `` (no `--hub` flag — daemon reads hub URL from its config; matches today's pair flow).

## 7. RealApp.tsx wiring

```ts
const daemonsHook = useDaemons(hubUrl, bearer);
const pushHook = usePushPrefs(hubUrl, bearer);
const pairingHook = usePairing(hubUrl, bearer, daemonsHook.refresh);

<SettingsDrawer
  daemons={daemonsHook.daemons}
  onRenameDaemon={daemonsHook.rename}
  onRevokeDaemon={daemonsHook.revoke}
  pushPrefs={pushHook.prefs}
  onTogglePref={pushHook.toggle}
  pairing={pairingHook.state}
  onGenerateCode={pairingHook.generate}
  onCancelPairing={pairingHook.cancel}
  daemonActionError={daemonsHook.lastActionError}
  pushActionError={pushHook.lastActionError}
  pairingError={pairingHook.lastError}
  // …
/>
```

`DemoApp.tsx` mirrors this with stub data — daemons hook returns a static `ready` state, pairing returns `idle` and a no-op `generate` so the UI is browseable in demo mode.

## 8. Testing

### 8.1 Unit (hub)

- `pair-issue.test.ts`
  - PWA-authenticated POST returns code + ttl.
  - Unauthenticated POST returns 401.
  - Issued code is consumable by `POST /pair` exactly once.
  - Code expires after TTL (override TTL via test seam if needed).
- `daemons-routes.test.ts`
  - `GET /daemons` lists only owner's daemons; revoked ones excluded.
  - `connected` flag reflects router's connected set.
  - `PATCH /daemons/:id` 204 on success, 404 on not-found / not-owned.
  - `DELETE /daemons/:id` revokes, clears JTI, calls `router.closeDaemonConnection`. Subsequent DPoP from the daemon is rejected.

### 8.2 Unit (pwa)

- `useDaemons.test.tsx` — happy path, error → retry, 60s poll fires.
- `usePairing.test.tsx` — fake timers; idle → issuing → active → countdown → idle on expiry; `onPaired` called on natural expiry.
- `usePushPrefs.test.tsx` — happy path, error → retry, toggle optimistic update.
- `SettingsDrawer.test.tsx` — render snapshot per resource state (loading/error/ready) per section; revoke confirm flow still works.

### 8.3 e2e-real

New scenario `e2e-real/tests/13-pair-from-pwa.test.ts`:

1. PWA logs in via fake-IAS.
2. Click ⚙ Settings → click "Generate code" → assert UI shows 6-char code + countdown.
3. Capture code from DOM.
4. In a sibling container, run `cc-remote pair <code> --hub <hub-url>` (uses existing daemon image).
5. Wait for daemon WS to register (existing helper).
6. Reopen Settings → assert "Paired daemons" list contains the new daemon with 🟢 Online.
7. Click Revoke → confirm → assert row disappears AND daemon WS gets closed (visible in daemon container log).

All existing scenarios (`01`-`12`) must continue to pass. The compose stack already brings up hub + fake-ias + daemon + pwa; this scenario adds no new services.

## 9. Migration & rollout

- Single hub binary upgrade (schema migration v2 runs on boot, idempotent).
- PWA bundle ships in the same release.
- No breaking change to daemon CLI or daemon ↔ hub protocol.
- `/devices` route stays in place (no callers in the new UI, but kept for any external scripts and for the push subscribe path which uses device bearer auth, not the route).

## 10. Risks & open questions

- **Race on rapid Generate clicks.** If a user clicks Generate twice in 200 ms, two codes get minted. Both work (5-min TTL each). Acceptable; UI disables button while `issuing`.
- **`onPaired` heuristic.** The hook can't observe the actual `POST /pair`. It calls `daemonsHook.refresh` on natural code expiry, which is a 5-min lag in the worst case. Acceptable: the user typically reopens Settings to verify, which also refreshes. A future improvement: hub broadcasts a `daemon_paired` frame on the PWA WS — out of scope here.
- **Connected flag staleness on /daemons.** `getConnectedDaemonIds()` reads the in-mem map at request time — accurate to the millisecond on the hub serving the request. With multi-hub deployment (none today), this becomes per-instance only. Documented; not blocking.
