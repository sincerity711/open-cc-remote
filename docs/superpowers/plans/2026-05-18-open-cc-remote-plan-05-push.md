# open-cc-remote — Plan 5: Web Push notifications

> **For agentic workers:** Compressed. Full code in dispatch prompts.

**Goal:** When the hub receives a permission_request, send Web Push notifications to all of the user's registered browsers/PWAs. User taps the notification → PWA opens → they approve/deny.

**Architecture:**
- VAPID keypair per hub (env var or auto-generated to disk)
- Service worker in PWA registers push subscription, POSTs to hub `/push/subscribe`
- Hub stores in `push_subs` (table already exists, schema from Plan 2)
- On permission_request, hub iterates the user's subscriptions and dispatches via `web-push` library

**Out of scope (deferred to Plan 6):**
- "My devices" management UI / rename / revoke
- Token rotation
- Per-event push preferences UI (default: only `permission_request` triggers push)

---

## Tasks

### T1 — Hub push_subs repo + VAPID config

`packages/hub/src/repos/push-subs.ts`: `addPushSub(db, device_id, endpoint, p256dh, auth)`, `removePushSub(db, device_id)`, `findSubsByOwner(db, owner_sub)`.

`packages/hub/src/config.ts` adds `vapid_public_key`, `vapid_private_key`, `vapid_subject` (mailto: or https URL). If unset, hub starts but Web Push is disabled (warns once).

Tests: insert/lookup/remove. No VAPID generation (assume keys provided).

### T2 — Hub /push/subscribe + push helper

POST endpoint: requires authenticated PWA (bearer cookie/header), body = `{ endpoint, keys: { p256dh, auth } }`. Resolves device_id via the bearer (token → device row), stores in push_subs.

`packages/hub/src/push.ts` — wraps `web-push` library. `sendPushTo(subs, payload)` iterates and best-efforts delivers; logs failures. Used in the next task.

Add `web-push` dep.

### T3 — Hub: push on permission_request

When the router receives a daemon `permission_request`, also dispatch Web Push to all subscriptions of the daemon's owner_sub. Payload: `{ kind: "permission", daemon_id, session_id, request_id, tool, args_summary }`.

Modify `Router` to hold a reference to db + push helper (constructor args expanded). Tests stay green by passing a no-op helper in test setup.

### T4 — PWA service worker + push registration

- `packages/pwa/public/sw.js` — service worker. On `push` event: show notification with body. On `notificationclick`: open PWA (focus existing tab if any).
- `packages/pwa/src/push.ts` — helper to register service worker, request notification permission, get push subscription, POST to hub `/push/subscribe`.
- `packages/pwa/src/App.tsx` — invoke registration after sign-in (effect-once).

### T5 — README + tag

Add Plan 5 status, document VAPID env vars, tag `plan-05-push`.

---

## Self-Review

**Spec coverage** (against §6.5 + §8.1 push_subs):
- VAPID-signed Web Push to user's devices on permission events ✓
- Per-event push preferences UI — deferred to Plan 6
- Service-worker-driven notifications ✓

Other event types (idle/completed/daemon_offline) — out of scope; only `permission_request` triggers push in Plan 5.
