# Push Topics Design

**Date:** 2026-05-25
**Status:** Draft
**Tag (after impl):** `plan-push-topics`

## Goal

Replace the four hardcoded push kinds (`permission` / `offline` / `completed` / `idle`) in `packages/hub/src/router.ts` with a data-driven **push topic** registry, so adding a new notification type touches one place. Bundle in two adjacent improvements that share migrations and UI:

- Per-daemon mute (e.g., "laptop receives idle alerts, office-desktop does not")
- Do-not-disturb time window
- Device-side dedup via Web Push `tag`
- PWA manifest + production VAPID deployment so Android Chrome and iOS 16.4+ installed PWAs receive push for real

The behaviour of the existing four notifications stays identical end-to-end after migration.

## Non-goals

- Daemon-declared topics (full pub/sub where daemons register custom topics at runtime). Kept on backlog; the registry shape leaves room.
- Server-side rate limiting / batching. Web Push `tag` collapses on the OS, which is sufficient for the current event volumes.
- Per-session mute granularity. Per-daemon is enough for now.
- Native APNs / FCM SDKs. Web Push covers Android Chrome and iOS 16.4+ installed PWAs through the browser's existing bridge.
- i18n of notification copy.

## Terminology

This document uses **push topic** (not "channel") for the pub/sub-style notification subject. The word "channel" is reserved for the unrelated Claude Code Channel mechanism (the Claude CLI plugin / MCP transport between `claude` and the daemon). Code uses `topic_id`, `push_topics`, `topic_subscriptions`.

## Current state (baseline)

- `push_subs.preferences` is a JSON column with shape `{ permission?, offline?, completed?, idle? : boolean }`. `permission` defaults true, others default false. One row per device — no per-daemon dimension.
- `router.ts` has four near-identical `dispatchXxxPush` private methods, each filtering subs on a fixed preference key.
- Triggers: `permission_request`, `task_completed`, `idle` frames (frame-driven); `daemon_offline` after a 30 s timer (timer-driven).
- `SettingsDrawer.tsx` renders four toggles from a hardcoded `PUSH_TOGGLES` array.
- `sw.js` renders the notification body with an `if/else if` over `data.kind`.

## Architecture

### Push topic registry (hub-internal const)

```ts
// packages/hub/src/push-topics.ts
export interface PushTopic {
  id: string;                      // "permission" | "offline" | "completed" | "idle" | future ids
  title: string;                   // "Permission alerts"
  description: string;             // shown in Settings
  default_enabled: boolean;        // applied when no subscription row exists
  bypass_dnd: boolean;             // true for permission only
  build_payload: (ctx: unknown) => PushPayload;
  build_tag: (payload: PushPayload) => string;
}

export const PUSH_TOPICS: ReadonlyArray<PushTopic> = [
  { id: "permission", default_enabled: true,  bypass_dnd: true,  /* ... */ },
  { id: "offline",    default_enabled: false, bypass_dnd: false, /* ... */ },
  { id: "completed",  default_enabled: false, bypass_dnd: false, /* ... */ },
  { id: "idle",       default_enabled: false, bypass_dnd: false, /* ... */ },
];

export function getTopic(id: string): PushTopic { /* throws if missing */ }
```

Adding a new topic = append a row + (if a new frame is needed) one new `case` in `router.ts` that calls `dispatchTopic(getTopic("…"), ...)`.

### Tag strategy (device-side dedup)

| Topic       | Tag                                          | Effect                                        |
|-------------|----------------------------------------------|-----------------------------------------------|
| permission  | `permission:${request_id}`                   | Same request never duplicates (current behaviour) |
| offline     | `offline:${daemon_id}`                       | One offline notification per daemon at a time |
| completed   | `completed:${daemon_id}:${session_id}`       | Latest "finished" replaces older for the session |
| idle        | `idle:${daemon_id}:${session_id}`            | Latest "idle" replaces older for the session  |

The OS notification layer collapses by `tag`; no server state.

### Frame triggers (router.ts)

The four `case`s in `onDaemonFrame` (and the `setTimeout` path in `onDaemonDisconnect`) keep their current broadcast behaviour and additionally call:

```ts
void dispatchTopic(this.db, this.push, getTopic("permission"), daemon_id, frame);
```

The four private `dispatchXxxPush` methods are deleted.

## Schema

### Migration v3

```sql
CREATE TABLE topic_subscriptions (
  device_id TEXT NOT NULL,
  topic_id  TEXT NOT NULL,
  daemon_id TEXT NOT NULL,                -- '' = device-wide default for this topic
  enabled   INTEGER NOT NULL,
  PRIMARY KEY (device_id, topic_id, daemon_id),
  FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
);

CREATE TABLE dnd_settings (
  device_id   TEXT PRIMARY KEY,
  enabled     INTEGER NOT NULL DEFAULT 0,
  start_hh_mm TEXT,                       -- "22:00"
  end_hh_mm   TEXT,                       -- "07:00"
  timezone    TEXT,                       -- IANA, e.g. "Asia/Shanghai"
  FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
);

-- Data migration: move existing preferences to topic_subscriptions (daemon_id='').
-- NULL/missing keys are left out so they fall back to topic.default_enabled.
INSERT INTO topic_subscriptions (device_id, topic_id, daemon_id, enabled)
SELECT ps.device_id, t.topic_id, '', t.raw
FROM push_subs ps
CROSS JOIN (
  SELECT 'permission' AS topic_id, json_extract(ps.preferences, '$.permission') AS raw FROM push_subs ps
  UNION ALL SELECT 'offline',   json_extract(ps.preferences, '$.offline')   FROM push_subs ps
  UNION ALL SELECT 'completed', json_extract(ps.preferences, '$.completed') FROM push_subs ps
  UNION ALL SELECT 'idle',      json_extract(ps.preferences, '$.idle')      FROM push_subs ps
) AS t
WHERE t.raw IS NOT NULL;
-- (The actual INSERT will be expressed as four explicit INSERT...SELECT statements
--  during implementation to avoid the cartesian-product trap above.)

-- push_subs.preferences column is left in place. A later migration removes it
-- once we are confident in the new path; keeping it allows hub binary rollback.
```

### Subscription resolution

For "is topic T enabled for device D against daemon X?":

1. If `(D, T, X)` row exists, use its `enabled`.
2. Else if `(D, T, '')` row exists, use its `enabled`.
3. Else use `PUSH_TOPICS[id=T].default_enabled`.

The single SQL used by `findActiveSubsForTopic`:

```sql
SELECT ps.device_id, ps.endpoint, ps.p256dh, ps.auth,
  COALESCE(
    (SELECT enabled FROM topic_subscriptions
       WHERE device_id = ps.device_id AND topic_id = ?1 AND daemon_id = ?2),
    (SELECT enabled FROM topic_subscriptions
       WHERE device_id = ps.device_id AND topic_id = ?1 AND daemon_id = ''),
    ?3                                                      -- topic.default_enabled (0/1)
  ) AS enabled
FROM push_subs ps
JOIN devices d ON d.device_id = ps.device_id
WHERE d.owner_sub = ?4 AND d.revoked_at IS NULL
HAVING enabled = 1;
```

## Dispatch

```ts
// packages/hub/src/push-dispatch.ts
export async function dispatchTopic(
  db: Db, push: PushHelper,
  topic: PushTopic,
  daemon_id: string,
  payload_ctx: unknown,
): Promise<void> {
  const daemon = findDaemon(db, daemon_id);
  if (!daemon) return;

  const subs = findActiveSubsForTopic(db, daemon.owner_sub, topic.id, daemon_id);

  const filtered = topic.bypass_dnd
    ? subs
    : subs.filter((s) => !isInDndWindow(getDndSettings(db, s.device_id), Date.now()));

  if (filtered.length === 0) return;

  const payload = topic.build_payload(payload_ctx);
  const tag = topic.build_tag(payload);
  await push.sendTo(filtered, { ...payload, tag });
}
```

### DND window check

```ts
export function isInDndWindow(dnd: DndSettings | null, nowMs: number): boolean {
  if (!dnd?.enabled || !dnd.timezone || !dnd.start_hh_mm || !dnd.end_hh_mm) return false;
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: dnd.timezone, hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(nowMs)).map((p) => [p.type, p.value]));
  const cur = Number(parts.hour) * 60 + Number(parts.minute);
  const start = parseHhMm(dnd.start_hh_mm);
  const end = parseHhMm(dnd.end_hh_mm);
  if (start === end) return false;
  return start < end ? (cur >= start && cur < end) : (cur >= start || cur < end);
}
```

## HTTP API

### Replaces the existing `/push/preferences` routes

| Method | Path                                   | Body / Effect                                                                                  |
|--------|----------------------------------------|------------------------------------------------------------------------------------------------|
| GET    | `/push/topics`                         | `{ topics: TopicMeta[], subscriptions: SubRow[], dnd: DndSettings }`                           |
| PUT    | `/push/topics/subscriptions`           | `{ topic_id, daemon_id?: string \| null, enabled: boolean }` — upsert one row (null ↔ '')      |
| DELETE | `/push/topics/subscriptions`           | `{ topic_id, daemon_id?: string \| null }` — delete one row (revert to default)                |
| PUT    | `/push/dnd`                            | `{ enabled, start_hh_mm, end_hh_mm, timezone }`                                                |

```ts
interface TopicMeta {
  id: string;
  title: string;
  description: string;
  default_enabled: boolean;
  bypass_dnd: boolean;
}
interface SubRow { topic_id: string; daemon_id: string | null; enabled: boolean }
interface DndSettings {
  enabled: boolean;
  start_hh_mm: string | null;
  end_hh_mm: string | null;
  timezone: string | null;
}
```

### Backward compatibility

`GET/PUT /push/preferences` are retained for **one** release, internally translating to/from the new tables (read = projection of `(D, t, '')` rows; write = upsert four rows). Removed in the release after.

## PWA UI

`SettingsDrawer.tsx` switches from a hardcoded `PUSH_TOGGLES` array to data-driven rendering of `topics[]` returned by `GET /push/topics`. Layout:

```
Push notifications
  Do not disturb               [○ off]
    when on, expand:  start [22:00]  end [07:00]  tz [Asia/Shanghai ▾]

  Defaults
    [✓] Permission alerts     (description text)
    [ ] Daemon offline
    [ ] Claude finished a turn
    [ ] Claude is idle

  Per-daemon overrides
    ▸ laptop (default)         [Override]
    ▾ office-desktop
        [ ] Permission alerts  (off, was on)
        [✓] Daemon offline     (on, was off)
        [Reset to defaults]
```

- "Defaults" rows write `(device, topic_id, daemon_id='')`.
- "Override" expands a daemon and lets the user tick the same topic list; ticks write `(device, topic_id, daemon_id=X)`.
- "Reset to defaults" deletes all `(device, *, daemon_id=X)` rows.
- DND timezone defaults to `Intl.DateTimeFormat().resolvedOptions().timeZone`.

`usePushPrefs` is replaced by `usePushTopics`:

```ts
interface UsePushTopicsResult {
  state: Resource<{
    topics: TopicMeta[];
    subscriptions: SubRow[];
    dnd: DndSettings;
  }>;
  setSub: (topic_id: string, daemon_id: string | null, enabled: boolean) => Promise<void>;
  resetDaemon: (daemon_id: string) => Promise<void>;
  setDnd: (dnd: DndSettings) => Promise<void>;
}
```

## Service worker

`public/sw.js` no longer hardcodes per-`kind` body templates. Hub builds the final body in `topic.build_payload`:

```js
self.addEventListener("push", (event) => {
  const data = event.data?.json() ?? {};
  event.waitUntil(self.registration.showNotification(data.title ?? "cc-remote", {
    body: data.body ?? "",
    tag: data.tag ?? "cc-remote",
    data,
    requireInteraction: data.require_interaction ?? false,
  }));
});
```

## PWA manifest

New file `packages/pwa/public/manifest.webmanifest`:

```json
{
  "name": "cc-remote",
  "short_name": "cc-remote",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#000000",
  "icons": [
    { "src": "/icon-192.png",          "sizes": "192x192", "type": "image/png" },
    { "src": "/icon-512.png",          "sizes": "512x512", "type": "image/png" },
    { "src": "/icon-512-maskable.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

`index.html` additions:

```html
<link rel="manifest" href="/manifest.webmanifest" />
<link rel="apple-touch-icon" href="/icon-192.png" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="theme-color" content="#000000" />
```

PNG icons are generated from a single SVG source (committed) via a one-shot script in `packages/pwa/scripts/`. The script runs only when the SVG changes; PNGs are committed.

## Production VAPID deployment

- Generate a key pair with `npx web-push generate-vapid-keys`.
- Hub env: `HUB_VAPID_PUBLIC_KEY`, `HUB_VAPID_PRIVATE_KEY`, `HUB_VAPID_SUBJECT=mailto:...` (matches existing `packages/hub/src/config.ts`).
- PWA reads the public key at build time from `VITE_VAPID_PUBLIC_KEY` (matches existing `packages/pwa/src/RealApp.tsx`). Build pipeline must inject it; the deployment doc covers this.
- Deployment requires HTTPS (Web Push hard requirement).
- New doc `docs/operations/push-deployment.md` covers: key generation, env wiring, HTTPS requirement, the iOS 16.4+ "Add to Home Screen" prerequisite, and a manual verification checklist (register → trigger permission → confirm OS notification on a real Android Chrome and iOS installed PWA).

## Testing

### Hub unit (`packages/hub/tests/`)

- `push-topics.test.ts` — `findActiveSubsForTopic` for: no rows (default), only default row, only daemon-specific row, both rows (daemon-specific wins).
- `push-dispatch.test.ts` — table-driven dispatch invokes `push.sendTo` with the right tag and body; `bypass_dnd=false` topics are filtered during DND windows; `bypass_dnd=true` are not.
- `dnd.test.ts` — `isInDndWindow` for: disabled, single-day window, cross-midnight window, exact boundaries, start==end, timezone application.
- `router.test.ts` (existing file) — `permission_request` / `task_completed` / `idle` frames each trigger `dispatchTopic` for the right topic id (spy on `dispatchTopic`); offline timer triggers offline topic.

### PWA unit (`packages/pwa/tests/`)

- `usePushTopics.test.ts` — load → ready, optimistic `setSub` updates state then calls API, `resetDaemon` removes daemon's overrides locally, error path surfaces `lastActionError`.
- `SettingsDrawer.test.tsx` — when API returns 3 topics, exactly 3 toggle rows render; per-daemon section lists connected daemons; clicking Override expands without server roundtrip.

### e2e-real (`e2e-real/tests/`)

- New scenario `21-push-topics.test.ts` covering both per-daemon override and DND in one flow:
  1. PWA logs in, registers fake push subscription, sees default topic list from `GET /push/topics`.
  2. Toggle global `idle=on`. Trigger `idle` frame on daemon_a → fake push receives one `idle:` notification with the expected `tag`.
  3. Add per-daemon override: `idle=off` for daemon_a. Trigger `idle` on daemon_a → no push received within 2 s.
  4. Trigger `idle` on daemon_b → push received (default still on).
  5. Set DND with a window covering "now" (computed from system time + small buffer) and `idle.bypass_dnd=false`. Trigger `idle` on daemon_b → no push.
  6. Trigger `permission_request` (bypass_dnd=true) during the DND window → push received.

If the existing compose only spawns one daemon, the scenario uses `daemon_b` from the multi-daemon compose service already used by scenario 15; otherwise the per-daemon-override step degrades to "ensure override row is honoured by `findActiveSubsForTopic`" and is unit-tested instead.

## Migration & rollback

- Migration v3 is idempotent: `CREATE TABLE` uses `IF NOT EXISTS`; the data move is safe to re-run because rows with the same `(device_id, topic_id, daemon_id)` PK are upserted (the migration uses `INSERT OR IGNORE` so a partial first run won't double-insert).
- `push_subs.preferences` stays in place for one release. Rollback to a prior hub binary still works because that binary reads the column it expects.
- Removal of the old column is a separate v4 migration shipped one release later, gated on telemetry showing zero reads of the legacy code path.

## Risks

- **iOS PWA expectation gap.** Users on iOS Safari (not installed) silently get no push. The deployment doc must set this expectation; the Settings page shows a notice when `Notification.permission !== "granted"` AND `navigator.standalone !== true` on iOS.
- **DND timezone drift.** Browsers can return rare IANA names; we validate against `Intl.supportedValuesOf("timeZone")` on save and reject invalid ones.
- **`tag`-based dedup is per-device.** Different devices owned by the same user still each get a copy. This is desired (laptop and phone both notify) and consistent with current behaviour.
- **Migration of malformed `preferences` JSON.** `json_extract` returns NULL on unparseable JSON; those rows fall back to topic defaults — same as a fresh device.

## Open questions

None at spec time. (DND default = opt-in; per-daemon mute = included; daemon-declared topics = out of scope.)
