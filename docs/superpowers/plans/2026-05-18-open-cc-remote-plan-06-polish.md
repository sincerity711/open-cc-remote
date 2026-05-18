# open-cc-remote — Plan 6: Operational polish

> **For agentic workers:** Compressed. Full code in dispatch prompts.

**Goal:** Close the highest-impact operational gaps: device management UI, daemon JWT rotation, and per-event push preferences. Acceptance harness, hardware-bound keys, real channel-permissions wire format, and OS service installers are genuinely substantial chunks that warrant their own plans (Plan 7+).

**Architecture:**
- Hub gains REST CRUD for devices: list user's devices, rename, revoke (with cascading push subscription deletion).
- Daemon gains `cc-remote daemon rotate-token` subcommand. Hub gains `POST /pair/refresh` that takes a current valid DPoP-proof and issues a new JWT (fresh jti).
- PWA gains a "Settings" page section listing devices with rename/revoke, plus a Plan 6 "rotate keys" button per daemon (calls into hub admin path).

**Out of scope (deferred to Plan 7+):**
- Acceptance suite (P95 latency, 30s offline detect)
- Hardware-bound keys (Secure Enclave / TPM)
- launchd / systemd installer (`cc-remote install`)
- Real Claude Code channel-permissions wire format integration
- request_history / scroll-back (separate feature plan)

These are documented as known gaps; the v1 product is functional without them.

---

## Tasks

### T1 — Hub: device management endpoints

`GET /devices` — list current user's devices (auth required).
`PATCH /devices/:id` — rename (body: `{ display_name }`).
`DELETE /devices/:id` — revoke device + delete push subscription.

Adds `listDevicesByOwner`, `renameDevice` to devices repo. Tests for each endpoint via direct fetch against `Bun.serve(makeServer({...}))`.

### T2 — PWA: "My devices" page

Add a `Settings` section opened from the header. Lists devices with rename input + revoke button. On revoke, fetch DELETE; on success remove from local list. On rename, fetch PATCH; on success update local list.

### T3 — Hub: daemon JWT rotation

`POST /pair/refresh` — daemon submits its current valid DPoP-bound JWT and a fresh DPoP JWS. Hub verifies the proof, looks up the daemon row, issues a new JWT with fresh `jti` and updates `daemons.jwt_jti`. Old `jti` immediately invalid (next request fails JWT-jti check).

`cc-remote daemon rotate-token` — daemon CLI subcommand: load current state.json, hit `/pair/refresh`, write new JWT.

Tests for the endpoint + the CLI.

### T4 — README + tag

Document the 3 new pieces. Mark deferred items (acceptance, hardware keys, installer, real CC permission) as Plan 7. Tag `plan-06-polish`.

---

## Self-Review

Three discrete, testable deliverables. Each makes the v1 product better operationally without venturing into platform-specific or acceptance-test territory.

The reason we deferred:
- **Acceptance suite**: requires latency harness, multi-machine spin-up — better as its own plan.
- **Hardware-bound keys**: per-platform abstraction (macOS Keychain Security framework + Linux libsecret + Windows DPAPI), each with its own bindings. Real engineering, real testing.
- **Installer**: writing & testing platform-specific service files needs CI infrastructure to validate.
- **Real channel-permissions wire format**: target spec is in Claude Code's source; needs investigation we can't do in this session.
- **request_history**: nice-to-have, but PWA already shows live events; not blocking initial use.
