# open-cc-remote — Plan 2: Auth (IAS + DPoP)

> **For agentic workers:** Plan 2 deviates from Plan 1's "full code in every step" convention. Each task here lists scope, interfaces, and acceptance criteria; the full code is supplied via the dispatch prompt at execution time. Subsequent re-derivation should consult commits referenced in the task footers.

**Goal:** Replace Plan 1's no-auth state. PWA requires IAS OIDC login. Daemon requires DPoP-bound JWT (Ed25519 keypair + proof-of-possession every connect). Hub gains SQLite persistence for users / daemons / devices / pairing codes.

**Architecture:**
- Hub becomes OIDC Relying Party. First IAS login on a browser auto-creates a `devices` row; bearer token issued and stored in the PWA (HttpOnly cookie + localStorage shadow).
- Daemon stores Ed25519 keypair on disk (file mode 0600 — Keychain/libsecret integration deferred to Plan 6). On `/ws/daemon` upgrade, daemon sends `Authorization: DPoP <jwt>` plus a `DPoP:` JWS-over-payload header (RFC 9449 shape, simplified).
- New `cc-remote` CLI binary in `packages/daemon`. `cc-remote pair --hub <url> --code <c>` is the daemon onboarding command.
- `cc-remote daemon` (existing entry) wired to the same CLI.

**Tech additions:**
- `jose` ^5.x — JWT/JWS sign/verify (both daemon and hub)
- `better-sqlite3` ^11.x — synchronous SQLite (both daemon and hub get it; daemon use comes in Plan 3)
- `openid-client` ^5.x — OIDC RP for the hub
- A test-only `tools/fake-ias` OIDC server (jose-signed id_tokens for fixed sub `i060912@sap.com`)

**Out of scope for Plan 2:**
- Web Push subscriptions table + service worker (Plan 5)
- Audit log (Plan 5)
- Token rotation / `cc-remote daemon rotate-token` (Plan 6)
- Keychain / libsecret backed keystore (Plan 6)
- "My devices" management UI (Plan 5)
- launchd / systemd installer (Plan 6)

---

## File map (Plan 2 additions)

```
packages/hub/src/
├── db.ts                ← Database wrapper + migrations
├── repos/
│   ├── daemons.ts
│   ├── devices.ts
│   └── pairing-codes.ts
├── auth/
│   ├── ias.ts           ← OIDC client + login/callback handlers
│   ├── pwa-auth.ts      ← bearer/cookie verification on /ws/pwa
│   └── dpop-verify.ts   ← DPoP JWS verification on /ws/daemon
├── pair.ts              ← /pair endpoint (POST: code+pubkey → JWT)
├── routes.ts            ← (modified) wires auth into upgrade
└── tests/...

packages/daemon/
├── bin/cc-remote.ts     ← new CLI entry; subcommands: daemon | pair
├── src/
│   ├── keystore.ts      ← file-based keypair store
│   ├── dpop.ts          ← JWS sign helper
│   └── hub-client.ts    ← (modified) sends DPoP on connect
└── tests/...

packages/pwa/src/
├── auth.ts              ← bearer storage + IAS-redirect helper
├── ws.ts                ← (modified) sends bearer on connect
└── App.tsx              ← (modified) shows login state

tools/fake-ias/
└── fake-ias.ts          ← test-only OIDC server

e2e/auth.test.ts         ← full IAS+pair+connect flow
```

---

## Tasks

### T1 — Hub SQLite foundation

**Adds:** `packages/hub/src/db.ts`, `packages/hub/src/schema.ts`, `packages/hub/tests/db.test.ts`. Add `better-sqlite3` to hub deps.

**Schema (Plan 2 subset, others added later):**

```sql
CREATE TABLE IF NOT EXISTS users (
  sub TEXT PRIMARY KEY, email TEXT, display_name TEXT,
  created_at INTEGER NOT NULL, last_login_at INTEGER
);
CREATE TABLE IF NOT EXISTS daemons (
  daemon_id TEXT PRIMARY KEY, owner_sub TEXT NOT NULL,
  hostname TEXT, public_key_jwk TEXT NOT NULL,
  paired_at INTEGER NOT NULL, last_seen_at INTEGER,
  jwt_jti TEXT, jwt_exp INTEGER, revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY, owner_sub TEXT NOT NULL,
  display_name TEXT, user_agent TEXT,
  paired_at INTEGER NOT NULL, last_seen_at INTEGER,
  token_hash TEXT NOT NULL, expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS pairing_codes (
  code TEXT PRIMARY KEY, kind TEXT NOT NULL,
  issuer_sub TEXT NOT NULL, metadata TEXT,
  expires_at INTEGER NOT NULL, consumed_at INTEGER
);
```

**Acceptance:** open db file → tables exist; running migrations again is no-op; tests pass.

### T2 — Hub auth repos

**Adds:** `packages/hub/src/repos/{daemons,devices,pairing-codes}.ts`, tests for each.

**Interfaces:**
```ts
// pairing-codes.ts
export function issueCode(db, kind, issuer_sub, metadata, ttlMs): string  // returns 6-digit code
export function consumeCode(db, code): { kind, issuer_sub, metadata } | null
// daemons.ts
export function pairDaemon(db, daemon_id, owner_sub, public_key_jwk, hostname): void
export function findDaemon(db, daemon_id): { owner_sub, public_key_jwk, revoked_at } | null
export function setJwtId(db, daemon_id, jti, exp): void
// devices.ts
export function createDevice(db, owner_sub, name, user_agent, token, ttlMs): { device_id }
export function findDeviceByToken(db, token): { device_id, owner_sub, expires_at, revoked_at } | null
```

**Acceptance:** all repo unit tests pass; consume-on-use semantics for pairing codes.

### T3 — fake-IAS test harness

**Adds:** `tools/fake-ias/fake-ias.ts`. A Bun.serve OIDC mock with `/.well-known/openid-configuration`, `/authorize`, `/token`, `/jwks.json`. Signs id_tokens with a deterministic test keypair (jose ES256). Subject is fixed via `FAKE_IAS_SUB` env var, default `i060912@sap.com`.

**Acceptance:** a hub configured against fake-IAS can complete /auth/callback and produce a session.

### T4 — Hub IAS OIDC integration

**Adds:** `packages/hub/src/auth/ias.ts` (uses `openid-client`), modifies `routes.ts` to add `/auth/login` (302 to authorize) and `/auth/callback` (handles code, validates id_token, ensures user row, ensures device row, sets HttpOnly cookie). Hub config gains `[ias]` section: issuer, client_id, client_secret, redirect_uri, allowed_subjects.

**Cookie:** `cc_session=<bearer>; HttpOnly; Secure; SameSite=Strict; Path=/`. The bearer is the same token stored in `devices.token_hash` (we keep the hash, send the raw value to the client).

**Acceptance:** end-to-end test using fake-IAS — first GET /auth/login redirects to fake-IAS, callback creates user + device + sets cookie; second visit lands authenticated.

### T5 — Hub /pair endpoint + admin issue-code helper

**Adds:** `packages/hub/src/pair.ts`, `POST /pair` route, tests. Plus a tiny admin helper `bun packages/hub/src/admin.ts issue-pairing-code <daemon_id>` for first-time daemon onboarding (since the PWA UI for this is Plan 5).

**`POST /pair` request:** `{ code, daemon_id, hostname, public_key_jwk }`
**Response:** `{ jwt }` (DPoP-bound; alg ES256; 24h exp)
**Validations:** code exists, not consumed, not expired; daemon_id not already taken; pubkey is a valid JWK.

**Acceptance:** valid code+pubkey returns a JWT containing `cnf.jkt` thumbprint of the pubkey; reuse rejected.

### T6 — Hub WSS auth

**Modifies:** `packages/hub/src/routes.ts`. PWA upgrade now requires bearer (from `Authorization: Bearer <t>` or `cc_session` cookie). Daemon upgrade now requires `Authorization: DPoP <jwt>` plus `DPoP: <jws>`.

**Adds:** `packages/hub/src/auth/pwa-auth.ts` (looks up token in devices), `packages/hub/src/auth/dpop-verify.ts` (verifies JWT signature on jkt-bound public key, verifies DPoP JWS htm/htu/iat/jti, jti seen-window 5min). Tests for each.

**Acceptance:** unauthorized upgrades 401; existing happy-path e2e (Plan 1's snapshot test) updated to authenticate first.

### T7 — Daemon keystore

**Adds:** `packages/daemon/src/keystore.ts`, tests. File-based: writes `${state_dir}/private.jwk` mode 0600, `${state_dir}/public.jwk`. Generates Ed25519 (jose `generateKeyPair("EdDSA", { crv: "Ed25519" })`) on first call.

**API:** `getOrCreateKeypair(stateDir): { privateJwk, publicJwk, thumbprint }`

**Acceptance:** idempotent; second call reuses existing files; permission 0600 verified.

### T8 — Daemon DPoP signing + hub-client integration

**Adds:** `packages/daemon/src/dpop.ts` (sign function), modifies `hub-client.ts` to fetch JWT from state.toml, sign DPoP JWS for the upgrade URL, send both headers. Tests.

**JWT location:** `${state_dir}/state.toml` with `jwt = "..."`. (Loaded as JSON for now — TOML parser deferred. State file is JSON-shaped.)

**Acceptance:** generated DPoP JWS verifies under public key; htm/htu match request.

### T9 — `cc-remote` CLI

**Adds:** `packages/daemon/bin/cc-remote.ts`. Subcommands:
- `cc-remote daemon` — runs the daemon (was `bun run packages/daemon/src/index.ts`)
- `cc-remote pair --hub <url> --code <c>` — generates keypair (via T7), POSTs to `<hub>/pair`, writes returned JWT to state file

**Acceptance:** pair against running fake-hub completes and produces JWT; daemon subcommand still works.

### T10 — PWA IAS flow + WSS bearer

**Modifies:** `packages/pwa/src/ws.ts` (sends `?bearer=...` on WSS), adds `packages/pwa/src/auth.ts` (reads cookie+localStorage, redirects to `/auth/login` on missing). Modifies `App.tsx` to show "Login" button if not auth'd.

**Acceptance:** opening PWA without session redirects to /auth/login; after fake-IAS login, app loads with daemons list.

### T11 — e2e auth test

**Adds:** `e2e/auth.test.ts`. Spawns fake-IAS + hub + simulates browser callback (curl-like) to obtain a session bearer + uses `cc-remote pair` to onboard a daemon + connects daemon WSS + connects PWA WSS with bearer + verifies snapshot loop.

**Replaces:** existing `e2e/snapshot.test.ts` updated to authenticate first (or marked legacy).

### T12 — README, final verify, tag

**Modifies:** `README.md` — Plan 2 quickstart with fake-IAS, env vars table, `cc-remote pair` flow.

**Verification:**
- `bun run typecheck` clean across 5 packages
- `bun test` green (existing + new auth tests)
- Tag `plan-02-auth`

---

## Self-Review

**Spec coverage:**
- §6.2 daemon ↔ hub DPoP — T7, T8, plus hub T6 verification
- §6.3 PWA ↔ hub IAS — T4, T6, T10
- §6.4 daemon onboarding pairing — T5, T9
- §6.5 owner-derived ACL — implicit in repo design (T2 stores `owner_sub` on every row); `canRoute` chokepoint added in T6
- §8.3 hub schema — T1, T2

**Deferred (with explicit task pointer for next plan):**
- Hub `push_subs` table + audit_log → Plan 5
- Token rotation → Plan 6
- macOS Keychain / libsecret keystore → Plan 6
- "My devices" page → Plan 5
- Per-device explicit ACL → noted as v2 only

**Type consistency:** repo function signatures defined in T2 are referenced by T4–T6, T9; daemon keystore output (privateJwk/publicJwk/thumbprint) flows into T8 unchanged.
