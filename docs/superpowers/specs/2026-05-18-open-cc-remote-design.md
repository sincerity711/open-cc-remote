# open-cc-remote — Design Spec

**Date:** 2026-05-18
**Status:** Approved by user (brainstorming complete)
**Project:** open-cc-remote
**CLI entry:** `cc-remote`

## 1. Goal

Make every Claude Code session running on the user's machines (typically inside tmux) reachable from a single phone/web UI. Receive notifications, reply to Claude, approve permission prompts, view live transcripts, and start/stop sessions remotely — across multiple machines.

Built on Claude Code's native `--channels` mechanism (a research-preview feature where MCP servers can push messages into a session and forward outbound events).

## 2. Non-goals

- Multi-tenant SaaS. Single-user system; the IAS `allowed_subjects` whitelist names exactly one human.
- Replacement for `claude` itself. The user keeps the option to launch raw `claude` and stay un-managed.
- Storing conversation content on the central hub. Conversation truth lives in Claude Code's own JSONL files; the hub never writes them to disk.
- Custom mobile native apps. PWA only.

## 3. Architecture overview

```
┌──────────── one of several user machines ────────────┐
│                                                       │
│  tmux session                                         │
│  └─ cc-remote run            (spawns:                 │
│         claude --channels plugin:cc-remote@local)     │
│                  │ MCP stdio (channel protocol)       │
│                  ▼                                    │
│            cc-remote plugin (thin)                    │
│                  │ Unix socket                        │
│                  ▼                                    │
│            cc-remote daemon (long-lived)              │
│                  │ persistent WSS (outbound 443)      │
└──────────────────┼────────────────────────────────────┘
                   ▼
           ┌──────────────────┐
           │   hub (VPS)      │ ← static PWA assets
           │   stateless      │
           │   routing only   │
           └────────┬─────────┘
                    │ WSS + Web Push
                    ▼
              ┌──────────┐
              │   PWA    │
              └──────────┘
```

Approach **A** in the brainstorm: daemon owns state of truth, hub is a stateless router, PWA reads via hub. Daemon makes outbound long-lived WSS — firewall-friendly, no public IP needed on user machines.

## 4. Components

### 4.1 plugin (`cc-remote` channel plugin, thin)

- MCP stdio server, invoked by `claude --channels plugin:cc-remote@local`
- Lifetime tied to a single Claude Code session
- Connects to local daemon over Unix socket at `~/.cc-remote/daemon.sock` (fallback `/tmp/cc-remote-$UID.sock`)
- Exposes MCP tools to Claude: `reply(text, files?)`, `ack(emoji)`, `edit_last(text)`
- Bridges inbound messages from daemon into Claude Code via the channel notification protocol
- Forwards permission prompts from Claude Code out to daemon; relays decisions back via the channel permission protocol (5-letter short codes)
- No persistence

### 4.2 daemon (`cc-remote daemon`, one per machine)

- Long-lived background process; managed by launchd (macOS) or systemd user unit (Linux); fallback PID-file daemonization
- Local Unix socket server for plugin registration
- Maintains in-memory `liveSessions` map (registered when plugins connect, removed on disconnect/`bye`)
- Watches each session's Claude Code JSONL file (`~/.claude/projects/<encoded_cwd>/<session_id>.jsonl`) for incremental events; forwards as `event` frames to hub
- Outbound persistent WSS to hub, with DPoP-bound JWT
- Reconnects with exponential backoff (1s → 2s → … → 30s cap)
- Local SQLite (`~/.cc-remote/db.sqlite`) for two things only: permission audit and offline outbox
- Optional remote actions (`start_session`, `kill_session`) gated by explicit opt-in plus `allowed_cwd_prefix`

### 4.3 hub (one VPS process)

- TLS-terminated HTTP + WSS server
- Static asset serving for the PWA
- IAS OIDC client (PWA login)
- DPoP verification for daemons
- Stateless router: forwards events from daemons to subscribed PWAs and commands from PWAs to the addressed daemon
- Maintains in-memory ring buffer (most recent 200 events per daemon) for short-window PWA reconnect gap-fill
- Web Push (VAPID) for notifications when PWA is offline
- Persistent SQLite (`/var/lib/cc-remote-hub/hub.sqlite`) for users, daemons, devices, push subs, daemon-pairing codes, audit log
- Never writes conversation content to disk. Files in transit go through `blobs/` with 24h TTL

### 4.4 PWA (single-page app + service worker)

- Lists every daemon and its sessions, with online/offline state
- Real-time transcript view per session, input box, file upload
- One-tap permission approve/deny
- Service worker handles Web Push when PWA is backgrounded; tapping a notification opens the relevant session

## 5. Auto-launch — `cc-remote` as launcher

The user opts into management explicitly per session. No PATH shimming, no shell alias, no override of `claude`. This way the user can tell at a glance whether a given Claude Code session is managed.

```bash
$ cc-remote install         # one-time: register plugin marketplace + install daemon service
$ cc-remote pair --hub <url> --code <code>   # one-time: bind this machine to the hub
$ cc-remote run             # daily: spawns claude --channels plugin:cc-remote@local
$ cc-remote                 # alias for `cc-remote run`
$ cc-remote --resume        # passes through to claude
$ cc-remote -- --model claude-opus-4-7 "fix it"  # everything after `--` is forwarded
$ claude                    # plain claude — un-managed, invisible to PWA (deliberate)
```

Subcommands: `run`, `install`, `uninstall`, `pair`, `daemon {status|start|stop|logs|rotate-token}`, `sessions`.

`cc-remote run` checks if the daemon is alive and starts it if not (equivalent to `cc-remote daemon start`, idempotent), so the daemon is up before the plugin tries to connect.

## 6. Authentication

### 6.1 plugin ↔ daemon (same machine)

No authentication. Unix socket file mode 0600 + `SO_PEERCRED`/`getpeereid` UID match. Same UID can already write to daemon files anyway; nothing to defend against here.

### 6.2 daemon ↔ hub (cross-machine)

**Ed25519 keypair + DPoP-bound JWT.** Industry pattern for proof-of-possession; defends against token-only theft.

- `cc-remote pair --code <c>` generates an Ed25519 keypair, stores the private key in macOS Keychain or Linux libsecret (fallback file mode 0600). Sends public key + pairing code to hub.
- Hub verifies the code, records the public key, issues a JWT bound to `jkt` (public-key thumbprint) with 24h TTL.
- Every WSS upgrade sends `Authorization: DPoP <jwt>` plus a `DPoP:` header — a JWS over `{htm, htu, iat, jti, nonce}` signed with the private key.
- Hub verifies: JWT signature & not-revoked; DPoP JWS verifies under the JWT's bound public key; `jti` not seen in the past 5 minutes; `htu` matches the request URL.
- Daemon rotates JWT before expiry using proof-of-possession; revocation is immediate.
- Pre-signed key abstraction layer so v2 can swap in Secure Enclave (macOS) or TPM 2.0 (Linux) backed keys.

### 6.3 PWA ↔ hub (human auth)

**IAS OIDC; no explicit pairing.** First IAS login on a new browser auto-creates a `devices` row.

- PWA loads → checks for `device_id` cookie + hub session cookie
- Missing or expired → redirects to IAS authorize endpoint (corp credentials / SSO)
- Callback handler:
  - Validates `id_token`; checks `sub ∈ allowed_subjects`
  - If no `device_id` cookie: generates ULID, names from User-Agent, inserts `devices` row (token_hash, expires_at = now + 30 days, owner_sub from `sub`)
  - Sets `device_id` HttpOnly cookie + writes to localStorage (double-write defends against cookie clears)
  - Issues bearer token; PWA stores it for WSS upgrade `Authorization: Bearer ...`
- "My devices" page in PWA: list, rename, revoke; revocation also clears Web Push subscription

### 6.4 Daemon onboarding (the one place pairing remains)

A daemon is not a human and cannot do an OIDC redirect. Pairing is the explicit "I am adding this machine":

```
PWA (already IAS-logged-in) → "Add daemon" → 6-digit code, 90s TTL
                                                      │
                          $ cc-remote pair --code 398-715
                                                      ▼
                            daemon submits public key + code → hub binds
```

Codes live in hub `pairing_codes` (consumed-on-use, expires automatically).

### 6.5 Access control

Single-user, owner-derived. `canRoute(device, daemon)` returns `device.owner_sub == daemon.owner_sub`. No separate ACL table. The function is a single chokepoint to extend later (per-device ACL or daemon tags) without touching call sites.

### 6.6 Threat model summary

| Threat | Mitigation |
| --- | --- |
| daemon JWT leaked alone | Useless without the private key (DPoP). Hub revoke = instant kill |
| daemon JWT + private key both leaked | Machine is rooted; out of scope. Hub-side anomaly alerts (geo/ASN jump) provide late warning |
| device token leaked | 30d rolling expiry; one-tap revoke from PWA |
| hub compromised | Dangerous actions (`start_session`, `kill_session`) are off by default and gated by `allowed_cwd_prefix` on each daemon |
| MITM | TLS required (hub rejects `ws://`); DPoP JWS includes `htu` |
| Same daemon_id, two connections | Hub kicks the older connection and alerts owner |

## 7. Wire protocol

Three legs, all JSON frames keyed by `type`. Length-prefixed JSON over Unix socket; JSON text frames over WSS.

### 7.1 plugin ↔ daemon

**plugin → daemon**

| type | payload |
| --- | --- |
| `register` | `{session_id, tmux_session?, tmux_pane?, cwd, model, pid, started_at}` |
| `event` | `{kind, ...}` — `assistant_msg` / `tool_call` / `idle` / `completed` |
| `permission_request` | `{request_id, tool, args_summary, expires_at}` |
| `bye` | `{}` |

**daemon → plugin**

| type | payload |
| --- | --- |
| `inbound_msg` | `{text, files?: [path]}` |
| `permission_reply` | `{request_id, decision: "allow" \| "deny"}` |
| `interrupt` | `{}` |

### 7.2 daemon ↔ hub

**daemon → hub** (post-DPoP handshake)

| type | payload |
| --- | --- |
| `hello` | `{daemon_id, epoch, hostname, agent_version, sessions: [SessionSnapshot]}` |
| `session_open` | `SessionSnapshot` |
| `session_close` | `{session_id, reason}` |
| `event` | `{session_id, jsonl_offset, kind, payload}` |
| `permission_request` | `{session_id, request_id, tool, args_summary, expires_at}` |
| `permission_resolved` | `{session_id, request_id, decision, decided_via}` |
| `pong` | `{ts}` |

**hub → daemon**

| type | payload |
| --- | --- |
| `send_msg` | `{session_id, text, files?: [url]}` |
| `permission_reply` | `{session_id, request_id, decision}` |
| `interrupt` | `{session_id}` |
| `start_session` | `{cwd, model?, name?}` (subject to opt-in) |
| `kill_session` | `{session_id}` (subject to opt-in) |
| `request_history` | `{session_id, before_offset, limit}` |
| `list_past_sessions` | `{project_dir?, since?}` |
| `ping` | `{ts}` |

### 7.3 hub ↔ PWA

| direction | type | payload |
| --- | --- | --- |
| hub → PWA | `snapshot` | `{daemons: [{daemon_id, hostname, online, sessions}]}` |
| hub → PWA | `daemon_online` / `daemon_offline` | `{daemon_id}` |
| hub → PWA | `daemon_resync` | `{daemon_id, sessions}` (replaces local cache after epoch change) |
| hub → PWA | `session_open` / `session_close` / `event` / `permission_request` / `permission_resolved` | (transparent forwards from daemon) |
| hub → PWA | `history_chunk` | `{session_id, events: [...]}` |
| PWA → hub | `send_msg` / `permission_reply` / `interrupt` / `start_session` / `kill_session` / `request_history` / `list_past_sessions` | same payloads as hub → daemon |

### 7.4 Cross-cutting protocol rules

- `request_id` is end-to-end stable: plugin generates it, never rewritten downstream
- Per-session `jsonl_offset` is the address for events. PWA reconnects send `last_event_offset` per session
- `epoch` on `hello` is daemon process start time (monotonically increasing). Epoch change → PWA discards stale per-session state
- File transfer: PWA uploads to hub `POST /upload` getting back a URL. Daemon downloads to `~/.cc-remote/inbox/<session>/` then passes the local path to plugin via `inbound_msg`. Reverse direction: daemon uploads to hub, PWA fetches by URL. Hub TTL on blobs: 24h
- All commands return ack frames so the sender can detect lost messages

## 8. Persistence

### 8.1 Storage map

| What | Where | Lifetime |
| --- | --- | --- |
| Conversation content (user/assistant/tool) | Claude Code's `~/.claude/projects/<proj>/<session_id>.jsonl` (external, read-only to us) | Managed by Claude Code |
| Daemon Ed25519 private key | macOS Keychain / Linux libsecret (fallback file mode 0600) | Permanent until uninstall |
| Daemon DPoP JWT | `~/.cc-remote/state.toml` (atomic replace) | 24h rolling |
| Daemon config (`daemon_id`, `hub_url`, `allowed_cwd_prefix`, danger flags) | `~/.cc-remote/config.toml` | Permanent |
| Permission audit | daemon SQLite `permissions` | 90d (configurable) |
| Outbox (frames pending while disconnected) | daemon SQLite `outbox` | 7d cap |
| Live session registry | daemon process memory | Process lifetime |
| User accounts (IAS `sub`) | hub SQLite `users` | Permanent |
| Daemons (public_key_jwk, owner_sub, jwt_jti, jwt_exp) | hub SQLite `daemons` | Permanent (soft delete on revoke) |
| Devices (token_hash, owner_sub, name) | hub SQLite `devices` | Permanent (soft delete on revoke) |
| Web Push subscriptions | hub SQLite `push_subs` | Tied to device |
| Daemon pairing codes | hub SQLite `pairing_codes` | 90s, consumed-on-use |
| Audit log | hub SQLite `audit_log` | Permanent (configurable retention) |
| Live connection map; per-daemon ring buffer (200 events) | hub process memory | Process lifetime |
| File-transfer blobs | hub `/var/lib/cc-remote-hub/blobs/` | 24h |

### 8.2 daemon SQLite schema

```sql
CREATE TABLE permissions (
  request_id   TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  tool         TEXT NOT NULL,
  args_summary TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  resolved_at  INTEGER,
  decision     TEXT,                 -- allow | deny | expired | terminal
  decided_via  TEXT                  -- pwa | terminal | web-push
);

CREATE TABLE outbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  frame      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

WAL mode; 200ms checkpoint cadence (loss window on hard crash ≤ 200ms).

### 8.3 hub SQLite schema

```sql
CREATE TABLE users (
  sub           TEXT PRIMARY KEY,
  email         TEXT,
  display_name  TEXT,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE daemons (
  daemon_id      TEXT PRIMARY KEY,
  owner_sub      TEXT NOT NULL REFERENCES users(sub),
  hostname       TEXT,
  public_key_jwk TEXT NOT NULL,
  paired_at      INTEGER NOT NULL,
  last_seen_at   INTEGER,
  jwt_jti        TEXT,
  jwt_exp        INTEGER,
  revoked_at     INTEGER,
  config         TEXT                -- JSON: allowed_cwd_prefix, dangerous_actions
);

CREATE TABLE devices (
  device_id     TEXT PRIMARY KEY,
  owner_sub     TEXT NOT NULL REFERENCES users(sub),
  display_name  TEXT,
  user_agent    TEXT,
  paired_at     INTEGER NOT NULL,
  last_seen_at  INTEGER,
  token_hash    TEXT NOT NULL,       -- SHA-256 of bearer
  expires_at    INTEGER NOT NULL,
  revoked_at    INTEGER
);

CREATE TABLE push_subs (
  device_id    TEXT PRIMARY KEY REFERENCES devices(device_id),
  endpoint     TEXT NOT NULL,
  p256dh       TEXT NOT NULL,
  auth         TEXT NOT NULL,
  preferences  TEXT NOT NULL          -- JSON
);

CREATE TABLE pairing_codes (
  code         TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,         -- "daemon"
  issuer_sub   TEXT NOT NULL,
  metadata     TEXT,
  expires_at   INTEGER NOT NULL,
  consumed_at  INTEGER
);

CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  actor_sub   TEXT,
  actor_kind  TEXT NOT NULL,          -- user | daemon | system
  action      TEXT NOT NULL,
  target      TEXT,
  detail      TEXT
);
```

The hub schema does not contain a column for conversation content.

### 8.4 Reading conversation history

PWA scrolls to load older events:

```
PWA → hub: request_history { session_id, before_offset: 9384, limit: 50 }
hub: validate device.owner_sub == daemon.owner_sub for the routed daemon
hub → daemon: request_history { ... }
daemon: read JSONL file backwards from `before_offset` for `limit` lines, parse each
daemon → hub → PWA: history_chunk { events: [...] }
```

No event table on the daemon; the JSONL file is the source of truth.

### 8.5 Listing past sessions

```
PWA → hub → daemon: list_past_sessions { project_dir?, since? }
daemon: scan ~/.claude/projects/<encoded_cwd>/*.jsonl
        - filename → session_id
        - mtime → last activity
        - first JSON line → starting metadata (model, etc.)
        - cross-check liveSessions for "still running" flag
daemon → list response
```

Pure function; no snapshot maintained.

## 9. Failure handling

### 9.1 plugin can't reach daemon

Plugin retries Unix socket connect every 3s for up to 90s. If it gives up, Claude Code is not blocked — the session simply doesn't appear in PWA. Plugin logs to stderr.

### 9.2 daemon can't reach hub

Exponential backoff 1s → 2s → 4s → 8s → 16s → 30s (capped). Permission requests during the gap are written to outbox and replayed on reconnect — but if expiry has already passed, daemon emits `permission_resolved {decision: "expired"}` instead of replaying as pending.

### 9.3 hub crash

Hub has no on-disk conversation state, so all sessions are restored via daemon `hello` frames after reconnect. Each daemon resends its current `epoch` and full `sessions[]`. PWAs receive `daemon_resync` and replace stale local caches.

### 9.4 PWA disconnect

Service worker continues to receive Web Push for high-priority events (permission requests, idle, completed). On foreground, PWA reconnects with `last_event_offset` per session; hub fills gaps from its in-memory ring buffer. If the gap exceeds 200 events, PWA falls back to `request_history`.

### 9.5 Permission relay race

Permission can be answered three ways: PWA tap, terminal in-place response, or another connected device's tap. Daemon enforces single-resolution per `request_id`:
- First answer wins (atomic SQLite update under unique index)
- Subsequent answers receive `already_resolved` error
- All connected PWAs see `permission_resolved` and clear their pending UI

### 9.6 Web Push policy

Default events that push notifications:

| Event | Push? |
| --- | --- |
| `permission_request` | Yes |
| `idle` (Claude waiting) | Yes, debounced 30s |
| `task_completed` | Yes |
| `assistant_msg` (regular streaming) | No |
| `tool_call` (progress) | No |
| `daemon_offline` | Yes, after 5min stable offline |

Per-event toggles available in PWA settings.

## 10. Testing strategy

### 10.1 Unit

- plugin: MCP tool surface, frame codec, register-failure isolation (Claude Code unaffected)
- daemon: registry mutations, JSONL incremental read with truncate edge case, DPoP JWT rotation, outbox durability, permission state machine
- hub: DPoP verification (signature + thumbprint match + jti window), IAS OIDC callback validation, ring-buffer dedup, single-resolution permission lock
- PWA: service-worker push decode, WSS reconnect with `last_event_offset`, idempotent permission button

### 10.2 Integration

- plugin ↔ daemon: register-then-disconnect (clean) and SIGKILL-mid-flight cases
- daemon ↔ hub: handshake success/fail, JWT rotation, double-connection eviction
- hub ↔ PWA: IAS callback creates devices row, WSS reconnect gap-fill correctness

### 10.3 End-to-end (selected)

`e2e/01_full_loop` — IAS login → add daemon → pair → fake Claude triggers permission → PWA approves → fake Claude receives allow → audit row present
`e2e/02_disconnect_recovery` — kill hub mid-session, restart, verify daemon resync within 30s and PWA history retrieval still works
`e2e/03_permission_race` — terminal yes vs PWA deny issued simultaneously; first-arrival wins, audit shows one decision
`e2e/04_offline_outbox` — daemon offline ≥ permission TTL; on reconnect, expired permission replayed as `expired`, not `pending`

### 10.4 Security

- DPoP replay: capture frame, replay → second attempt rejected by jti dedup
- DPoP token swap: daemon A's DPoP header with daemon B's JWT → thumbprint mismatch
- Device token replay: forged token → reject; revoked token → reject
- Cross-user routing: device of user U1 against daemon of user U2 → 403
- Dangerous-action gate: `start_session` against daemon without opt-in → reject + audit row

### 10.5 Acceptance criteria (v1)

- One-command install (`cc-remote install` registers plugin + installs daemon service)
- One-command pair (`cc-remote pair --code <c>`)
- One-command run (`cc-remote run` replaces `claude`)
- Offline detection ≤ 30s; reconnect self-heal ≤ 2s
- Permission round-trip P95 < 1s on same-region network
- ≥ 3 daemons concurrently against one hub verified
- Web Push delivers permission notification while phone is locked; tap-to-approve works
- Transcript scroll-back to any past session works
- Hub audit log enumerates last 30 days of permission decisions

## 11. Open implementation questions

These are flagged for the implementation phase, not blocking design approval:

1. Does `claude --resume` produce a new `session_id` or reuse the previous one? Daemon UI grouping logic depends on this.
2. JSONL schema versioning: parser must tolerate unknown fields and detect format changes gracefully.
3. Concurrency: macOS / Linux POSIX append-write + read pattern is safe; no Windows support claimed.
4. Pre-existing tmux sessions started before daemon installation are not retroactively manageable (they were not launched via `cc-remote run`). Documented as user expectation.

## 12. v2 candidates (out of scope for v1)

- Hardware-bound daemon keys (Secure Enclave / TPM) via the keystore abstraction
- WebAuthn / passkey requirement for sensitive operations (replaces "input pairing code" as defense in depth)
- Per-device explicit ACL and/or daemon tags for multi-user or shared setups
- Short-lived share tokens for read-only delegation (e.g., letting a colleague observe a session for debugging)
