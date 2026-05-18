# open-cc-remote — Plan 9: Push preferences UI

> **For agentic workers:** Compressed. Full code in dispatch prompts.

**Goal:** User can opt out of push notifications per-device. Preferences stored on hub, respected when sending Web Push.

**Architecture:**
- `push_subs.preferences` column already exists (JSON, defaulted to `{ permission: true }` since Plan 5)
- New endpoints: `GET /push/preferences`, `PUT /push/preferences`
- Push helper checks preferences before dispatching (or pre-filters at fanout time)
- Settings panel adds a checkbox: "Notify me about permission requests" (only event type we push today)

**Out of scope:** Push for other event types (idle/completed/daemon_offline) — these aren't pushed today; adding them is a separate effort. Plan 9 just exposes the on/off knob for the existing permission push.

---

## Tasks

### T1 — Hub preferences repo + endpoints

`packages/hub/src/repos/push-subs.ts` adds `getPreferences(db, device_id)` and `setPreferences(db, device_id, prefs)`.

Routes:
- `GET /push/preferences` — auth required, returns the device's preferences object (default `{ permission: true }` if no row)
- `PUT /push/preferences` — auth required, body merges into existing prefs

Filter outgoing pushes: in `findSubsByOwner`, return preferences alongside, and `dispatchPush` in router checks `prefs.permission !== false`.

### T2 — PWA Settings preferences section

Settings.tsx adds a "Push notifications" section with a single toggle (today: permission requests). Calls `GET /push/preferences` on mount, `PUT` on toggle.

### T3 — README + tag

Document, tag `plan-09-prefs`.
