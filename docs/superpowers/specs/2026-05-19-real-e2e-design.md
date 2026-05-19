# Real-component e2e test suite — Design Spec

**Date:** 2026-05-19
**Status:** Approved by user (brainstorming complete)
**Project:** open-cc-remote
**Scope:** A new `e2e-real/` test suite that exercises the v1 acceptance checklist against real components (real hub binary in docker, real `cc-remote daemon` on host, real `claude --channels` invocation, scripted PWA-equivalent client). Complements — does not replace — the existing 11 in-process e2e tests in `e2e/`.

## 1. Goal

Validate the v1 acceptance checklist (per design spec §10.5 and current README "Verified acceptance" section) against components running as they would in production, isolated from cloud infrastructure cost and complexity. Catch failure modes that the existing fake-claude / fake-IAS / localhost-glue tests cannot — TLS-style network boundaries, real OIDC redirect chains, real Claude Code JSONL emission, real channel-permission protocol round-trip.

## 2. Non-goals

- Real Web Push delivery to phones / service workers. Push out-call from the hub is verified via a file-log stub (Section 6).
- Real SAP IAS tenant. fake-IAS in docker validates OIDC flow shape; real-IAS is a deployment concern.
- Real cloud VPS / TLS / CDN. docker compose is the staging stand-in.
- macOS Keychain / Linux libsecret keystore backends. Real e2e uses the file-backed Ed25519 keystore that ships today.
- A real browser PWA (Playwright / service worker). The PWA-side is exercised via a scripted WSS+HTTP client per the wire contract.
- Replacing the existing `e2e/` suite (the fast in-process tests stay as the merge gate).

## 3. Architecture overview

```
┌────────── Mac host ──────────┐                ┌─ docker network "ccr-test" ───┐
│                              │                │                                │
│  bun test e2e-real/          │                │  ┌─────────────────────────┐  │
│   ├─ helpers/compose.ts ─────┼─ docker up ───▶│  │ fake-ias service         │  │
│   ├─ helpers/daemon.ts       │                │  │   port 7770 (internal)   │  │
│   ├─ helpers/claude.ts       │                │  └─────────────────────────┘  │
│   └─ helpers/pwa-client.ts   │                │                                │
│        │                     │                │  ┌─────────────────────────┐  │
│        │ HTTP+WSS            │                │  │ hub service              │  │
│        ▼   to localhost:7745 │                │  │   port 7745 → host:7745  │  │
│   real cc-remote daemon ─────┼─ ws://localhost:7745 ┼─▶│ HUB_IAS_ISSUER=fake-ias   │  │
│        │ Unix socket         │                │  └─────────────────────────┘  │
│        ▼                     │                │                                │
│   real claude --channels     │                │   (volume "hub-data" wipes     │
│   (writes JSONL host-side)   │                │    on each compose down -v)    │
│                              │                │                                │
└──────────────────────────────┘                └────────────────────────────────┘
```

Topology rationale:

- **hub + fake-IAS in docker compose**: separate network namespace, real container-to-container DNS, real volume cleanup, exercises the deployment topology shape without cloud cost.
- **daemon, Claude Code, PWA-equivalent run on host**: daemon needs real macOS user environment (state dir, keystore file paths); Claude Code needs the user's `ANTHROPIC_API_KEY` and any login state; PWA-equivalent script driving from host is the simplest approach.
- **No TLS in this suite**: hub is `http://`/`ws://` inside docker, exposed to host on `localhost:7745`. Real TLS belongs to a future staging deployment plan.

## 4. Components

### 4.1 docker-compose.yml

Two services:

- `fake-ias` — built from `tools/fake-ias/fake-ias.ts` packaged in a `oven/bun:1` image. Exposes port 7770 to the docker network only (not to host). Healthcheck hits `/.well-known/openid-configuration`.
- `hub` — built from `packages/hub/` plus its workspace deps (`packages/proto/`). Listens on 7745, port-mapped to `host:7745`. Healthcheck hits `/healthz`. `depends_on: fake-ias: { condition: service_healthy }`. Receives env: `HUB_IAS_ISSUER=http://fake-ias:7770`, `HUB_IAS_REDIRECT_URI=http://localhost:7745/auth/callback`, `HUB_IAS_ALLOWED_SUBJECTS=i060912@sap.com`, `HUB_TEST_MODE=1` (enables file-log push stub — Section 6), `HUB_DB_PATH=/data/hub.sqlite`. `hub-data` named volume mounted at `/data`. `compose down -v` between scenarios wipes state.

Dockerfiles live in `e2e-real/fixtures/`.

### 4.2 helpers/compose.ts

```ts
export async function upCompose(): Promise<void>;     // runs `docker compose up -d --wait`; throws with full logs on failure
export async function downCompose(): Promise<void>;   // runs `docker compose down -v`
export function execHubCmd(argv: string[]): string;   // `docker compose exec -T hub <argv>` returns stdout
```

### 4.3 helpers/daemon.ts

Spawns `bun run packages/daemon/src/index.ts` with a per-scenario `CC_REMOTE_STATE_DIR` (mkdtemp). Writes `config.json` (daemon_id, hub_url, allow_kill, allow_start, allowed_cwd_prefix, spawn_command, idle_window_ms). Captures stderr. `stop()` SIGTERMs and rms the state dir. Helper companion: `pairDaemon(state_dir, hub_http_url, code)` invokes `cc-remote pair --hub <url> --code <code>` against the real CLI.

### 4.4 helpers/claude.ts

Spawns `claude --channels plugin:cc-remote@local -p "<prompt>" --output-format json` with `cwd` = the test session's cwd. Requires `process.env.ANTHROPIC_API_KEY`; throws fail-fast if absent. Captures stderr. `stop()` SIGTERMs.

Default model: `claude-haiku-4-5-20251001` (cheapest; sufficient for deterministic short prompts). Override via `CCR_E2E_MODEL` env.

### 4.5 helpers/pwa-client.ts

Drives the IAS login chain with `fetch(..., { redirect: "manual" })`:

1. `GET /auth/login` → 302 → fake-IAS authorize URL
2. `GET <authorize>` → 302 → callback URL with `?code=...&state=...`
3. `GET <callback>` → 302 with `Set-Cookie: cc_session=...` and `Location: <pwa_url>#bearer=<token>`
4. extracts bearer from fragment
5. opens WSS `/ws/pwa?bearer=<token>`, sends `{type:"subscribe"}`

Returns a handle with: `bearer`, `ws`, `inbox: HubToPwa[]`, `send(frame)`, `waitFor(predicate, timeoutMs)`, `approve(req)`, `deny(req)`, `close()`.

`waitFor` checks the existing inbox first, then subscribes to future frames. Default timeout 10s; scenarios involving real Claude turn up to 30s.

### 4.6 helpers/admin.ts

`issuePairingCode(daemon_id)` runs `docker compose exec -T hub bun run /app/packages/hub/src/admin.ts issue-pairing-code i060912@sap.com <daemon_id>` and trims stdout. Avoids exposing admin endpoints to host network.

### 4.7 Scenarios — `e2e-real/tests/*.test.ts`

One file per scenario. Each `beforeAll` calls `upCompose`; `afterAll` calls `downCompose`. Each test uses unique `daemon_id` (`<scenario>-${Date.now()}`) and a fresh PwaClient. `try { ... } finally { pwa.close(); claude.stop(); await daemon.stop(); }` to keep state clean across tests within a file.

## 5. Acceptance scenarios (the 11)

| # | File | What it proves | Claude prompt |
|---|------|----------------|--------------|
| 01 | `01-pair-and-snapshot.test.ts` | pair → real Claude session → PWA snapshot includes the session_id | `"echo hi"` |
| 02 | `02-permission-relay.test.ts` | Claude tool call → permission_request to PWA → PWA approve → Claude continues → task_completed | `"Read /tmp/ccr-e2e-sandbox.txt and tell me its first line."` |
| 03 | `03-permission-deny.test.ts` | same setup as 02 but PWA denies | same prompt |
| 04 | `04-history-scrollback.test.ts` | session runs → PWA `request_history` → all events returned ordered | `"echo line1, then echo line2, then echo line3."` (multi-turn output) |
| 05 | `05-task-completed.test.ts` | assistant + end_turn → task_completed frame surfaces | `"echo done"` |
| 06 | `06-idle.test.ts` | task_completed + 500ms quiet → idle frame (`idle_window_ms: 500`) | `"echo idle test"` |
| 07 | `07-multi-daemon.test.ts` | 3 daemons concurrent, all surface | uses fake-claude (3 sessions); not real Claude — explicit boundary |
| 08 | `08-kill-session.test.ts` | `allow_kill: true` daemon + PWA `kill_session` → claude exits + session_close | `"count from 1 to 100, one per line"` (long enough to interrupt) |
| 09 | `09-start-session.test.ts` | `allow_start: true`, `spawn_command` runs claude → second session surfaces | spawn_command prompts claude for `"echo started"` |
| 10 | `10-perm-p95.test.ts` | 20 sequential Read permissions, P95 < 1s | `"Read these 20 files: /tmp/f1 ... /tmp/f20"` |
| 11 | `11-offline-push.test.ts` | daemon disconnects → after `OFFLINE_PUSH_DELAY_MS=200` → push helper invoked (file-log stub) | no Claude — daemon kill + read trace |

Cost budget: ~$0.05 per full suite at default Haiku.

## 6. Test-mode push helper (file-log stub)

The hub creates the push helper via `createPushHelper(vapid)`. Real e2e wants to assert "hub attempted to push" without depending on real push providers. Add a thin branch in `packages/hub/src/push.ts`:

```ts
export function createPushHelper(vapid: VapidConfig | undefined): PushHelper {
  if (process.env.HUB_TEST_MODE === "1") return fileLogHelper("/data/push-trace.log");
  if (!vapid) return noopHelper;
  // existing real path...
}
```

`fileLogHelper` appends one JSON line per `sendTo` call (subs metadata + payload) to the path. The hub container's `hub-data` volume includes this file. Tests read it via `execHubCmd(["cat", "/data/push-trace.log"])`.

This adds one production-code branch (gated by env), but keeps the rest of `push.ts` unchanged. The fake-e2e suite is unaffected.

## 7. Error handling and diagnostics

Failure modes and their handling:

| Failure | Handling |
|---|---|
| docker compose up never reaches healthy | Throw with `docker compose logs` full output |
| daemon spawn never logs "ready" | Throw with daemon stderr |
| Claude Code spawn fails (binary missing, exit non-zero) | Throw with claude stderr; pre-check that `claude` is on PATH and `ANTHROPIC_API_KEY` is set; fail-fast on missing |
| PwaClient.waitFor times out | Error message bundles last 20 frames from inbox + the predicate description + daemon stderr + claude stderr |
| `cc-remote pair` 4xx response | Throw with response body |
| Anthropic API 429 | One retry with 5s backoff; second failure throws |
| Plugin not registered with Claude Code | Pre-check that `cc-remote install` ran (Plan 8); fail-fast with explicit guidance |
| Test scenario assertion fails | All cleanup runs in `try/finally`: pwa.close, claude.stop, daemon.stop. compose stays up across the file (afterAll handles teardown) |

A failed test run prints diagnostic blocks (PWA inbox tail, daemon stderr tail, claude stderr tail) without requiring re-run.

## 8. Suite acceptance criteria

The real-e2e suite itself succeeds when:

- A single `bun test e2e-real/` from a clean checkout completes in < 5 minutes
- 11 scenarios pass on first run; flaky retries are not allowed (a < 100% pass rate signals a real bug — product or test)
- Failure output sufficient to localize the problem without rerun
- Pre-flight checks on missing prereqs (`docker`, `claude`, `ANTHROPIC_API_KEY`, `cc-remote install`) fail with explicit, actionable guidance

## 9. Open implementation questions (not blocking design approval)

These get resolved during implementation, recorded here for transparency:

1. **Claude Code channel-permission wire format** — current implementation has not integrated with the real protocol; user has flagged that an investigation pass (Google search for protocol docs) precedes implementation. If protocol turns out to be poorly documented, scenarios 02/03/10 fall back to using `CC_REMOTE_FAKE_PERMISSION` for the trigger and accept that as a documented gap until protocol is reverse-engineered or specified upstream. See `prereq: 调查 channel-permission 协议` task.
2. **Multi-platform docker variants** — fake-ias and hub Dockerfiles are written for `oven/bun:1` (Linux/amd64 by default). On Apple Silicon, builds use the platform-native image. No cross-arch testing in v1.
3. **Volume cleanup on test crash** — `down -v` only runs in `afterAll`. If `bun test` is killed mid-run, the next run begins with a hub-data volume that has stale state. Tests start with a fresh DB anyway (each scenario uses unique daemon_id), but the volume can grow unbounded. Documented in README; manual `docker compose -f e2e-real/docker-compose.yml down -v` recovers.
4. **Concurrent test runs on the same machine** — port 7745 is the chokepoint. v1 documents "one suite at a time"; future could parameterize port via env.

## 10. Out of scope (v2+ candidates)

- Real Web Push to a real subscription (would require a real test browser + real push provider account)
- Real SAP IAS tenant test (would require an IAS test client registration)
- Real VPS staging gate (would require a per-PR provisioned VM / fly.io app)
- Headless browser PWA tests (Playwright)
- macOS Keychain / Linux libsecret keystore tests (per-platform CI)
- Cross-platform tests for the daemon (today only macOS verified manually)
