# Real-component e2e test suite — Design Spec

**Date:** 2026-05-19 (rewritten 2026-05-20 to align with plugin MCP rework)
**Status:** Approved by user (brainstorming v2 complete)
**Project:** open-cc-remote
**Scope:** A new `e2e-real/` test suite that exercises the v1 acceptance checklist against real components (real hub binary in docker, real `cc-remote daemon` on host, real `claude` invocation under tmux, scripted PWA-equivalent client). Complements — does not replace — the existing in-process e2e tests in `e2e/`.

## Changelog

- **2026-05-20** — Rewrite. Plugin MCP rework landed (`tag plan-plugin-mcp-rework`). Three rounds of T0 spike (`docs/superpowers/research/2026-05-20-p-mode-permission-spike.md`) determined that:
  1. `claude --plugin-dir packages/plugin -p "..."` skips the channel-permission protocol by design (`-p` mode bypasses interactive permission UI; classification A2, twice confirmed).
  2. `claude --mcp-config <file> --dangerously-load-development-channels server:cc-remote` driven through tmux **does** engage the full channel-permission protocol (classification A1 confirmed; round-trip ~59ms, sandbox `Bash rm -rf` triggers a real `permission_request` frame with valid 5-char `request_id`).
  3. The `--setting-sources project,local` flag isolates from user `~/.claude/settings.json` (avoids `bypassPermissions` / other dev overrides leaking in).
- All scenarios now drive `claude` via tmux + interactive mode using the unblocking flags. `-p` mode is dropped entirely.
- `CC_REMOTE_FAKE_PERMISSION` was deleted in the plugin rework; permission scenarios now use Path A (real protocol) end-to-end.

## 1. Goal

Validate the v1 acceptance checklist against components running as they would in production, isolated from cloud cost. Catch failure modes that the in-process `e2e/` suite cannot — TLS-style network boundaries, real OIDC redirect chains, real Claude Code JSONL emission, real channel-permission protocol round-trip via the MCP plugin.

## 2. Non-goals

- Real Web Push delivery to phones / service workers (file-log stub — §6).
- Real SAP IAS tenant (fake-IAS in docker validates flow shape).
- Real cloud VPS / TLS / CDN.
- Real macOS Keychain / Linux libsecret keystore (file-backed Ed25519 keystore is in scope).
- A real browser PWA via Playwright (PWA exercised via scripted WSS+HTTP client per the wire contract).
- Replacing the existing `e2e/` suite (the fast in-process tests stay as the merge gate).
- Marketplace / `claude plugin install` integration (loaded via `--mcp-config` — see §4.4).

## 3. Architecture overview

```
┌────────── Mac host ──────────┐                ┌─ docker network "ccr-test" ───┐
│                              │                │                                │
│  bun test e2e-real/          │                │  ┌─────────────────────────┐  │
│   ├─ helpers/compose.ts ─────┼─ docker up ───▶│  │ fake-ias service         │  │
│   ├─ helpers/daemon.ts       │                │  │   port 7770 (internal)   │  │
│   ├─ helpers/claude-tmux.ts  │                │  └─────────────────────────┘  │
│   └─ helpers/pwa-client.ts   │                │                                │
│        │                     │                │  ┌─────────────────────────┐  │
│        │ HTTP+WSS            │                │  │ hub service              │  │
│        ▼   to localhost:7745 │                │  │   port 7745 → host:7745  │  │
│   real cc-remote daemon ─────┼─ ws://localhost:7745 ─▶│  HUB_TEST_MODE=1   │  │
│        │ Unix socket         │                │  └─────────────────────────┘  │
│        ▼                     │                │                                │
│   real claude (tmux pane) ───┼─ stdio MCP ──▶ packages/plugin (loaded by MCP)  │
│                              │                                                  │
└──────────────────────────────┘                └────────────────────────────────┘
```

Topology rationale:

- **hub + fake-IAS in docker compose**: separate network namespace, real container-to-container DNS, real volume cleanup, exercises deployment topology shape without cloud cost.
- **daemon, Claude Code, PWA-equivalent run on host**: daemon needs the real macOS user environment (state dir, keystore file paths); Claude Code needs `ANTHROPIC_API_KEY` from the user's shell; a PWA-equivalent script driving from host is the simplest approach.
- **tmux**: Claude Code loads the plugin via `--mcp-config` and engages channel-permission only when running under a real PTY. Tmux provides that PTY and is scriptable via `send-keys` + `capture-pane`. Required on the host (preflight checks for it).
- **No TLS in this suite**: hub is `http://`/`ws://` inside docker, exposed to host on `localhost:7745`. Real TLS belongs to a future staging deployment plan.

## 4. Components

### 4.1 docker-compose.yml

Two services (unchanged from v1):

- `fake-ias` — built from `tools/fake-ias/fake-ias.ts` packaged in `oven/bun:1`. Internal port 7770. Healthcheck on `/.well-known/openid-configuration`.
- `hub` — built from `packages/hub/` + workspace deps. Listens 7745, port-mapped to `host:7745`. Healthcheck on `/healthz`. `depends_on: fake-ias: { condition: service_healthy }`. Env: `HUB_IAS_ISSUER=http://fake-ias:7770`, `HUB_IAS_REDIRECT_URI=http://localhost:7745/auth/callback`, `HUB_IAS_ALLOWED_SUBJECTS=i060912@sap.com`, `HUB_TEST_MODE=1` (file-log push stub — §6), `HUB_DB_PATH=/data/hub.sqlite`, `HUB_OFFLINE_PUSH_DELAY_MS=300`. `hub-data` named volume mounted at `/data`. `compose down -v` between scenarios wipes state.

Dockerfiles in `e2e-real/fixtures/`.

### 4.2 helpers/compose.ts

```ts
export async function upCompose(): Promise<void>;     // `docker compose up -d --wait`; throws with logs on failure
export async function downCompose(): Promise<void>;   // `docker compose down -v`
export function execHubCmd(argv: string[]): string;   // `docker compose exec -T hub <argv>` returns stdout
```

### 4.3 helpers/daemon.ts

Spawns `bun run packages/daemon/src/index.ts` with per-scenario `CC_REMOTE_STATE_DIR` (mkdtemp). Writes `config.json` (daemon_id, hub_url, allow_kill, allow_start, allowed_cwd_prefix, spawn_command, idle_window_ms). Captures stderr. `stop()` SIGTERMs and rms the state dir. `pairDaemon({state_dir, hub_url, code, daemon_id})` invokes `cc-remote pair` against the real CLI.

### 4.4 helpers/claude-tmux.ts (renamed from helpers/claude.ts)

The single way to launch real Claude Code in this suite. Uses tmux interactive mode + the unblocking flags discovered in T0 spike round 3.

```ts
export interface StartClaudeTmuxOpts {
  cwd: string;
  prompt: string;            // single-shot prompt; sent via send-keys + Enter after boot
  sessionName: string;       // unique tmux session name, e.g., `ccr-${scenario}-${Date.now()}`
  socketPath: string;        // CC_REMOTE_SOCKET → daemon Unix socket
  mcpConfigPath: string;     // path to the temporary mcp-config.json (helper writes it)
  pluginEntryPath: string;   // absolute path to packages/plugin/src/index.ts
  apiKey?: string;           // defaults to process.env.ANTHROPIC_API_KEY; throws if neither
  model?: string;            // defaults to "claude-haiku-4-5"
  bootTimeoutMs?: number;    // default 15_000
  promptTimeoutMs?: number;  // default 60_000 (interactive boot + first prompt)
}

export interface ClaudeTmuxHandle {
  sessionName: string;
  capturePane(): string;     // current visible buffer (for diagnostics)
  stop(): void;              // tmux kill-session -t <sessionName>
  isAlive(): boolean;        // tmux has-session
}

export async function startClaudeTmux(opts: StartClaudeTmuxOpts): Promise<ClaudeTmuxHandle>;
```

**Internal sequence:**
1. Write `mcpConfigPath` JSON: `{ "mcpServers": { "cc-remote": { "command": "bun", "args": ["run", pluginEntryPath], "env": { "CC_REMOTE_SOCKET": socketPath } } } }`.
2. `tmux new-session -d -s <name> -x 200 -y 50`.
3. `tmux send-keys -t <name> "ANTHROPIC_API_KEY=... claude --mcp-config <path> --dangerously-load-development-channels server:cc-remote --model <model> --setting-sources project,local" Enter`.
4. `dismissDialog(name, /Allow.*development.*channels/i)` — poll `capture-pane` every 250ms; on match send `Enter`. Timeout 10s.
5. `dismissDialog(name, /trust.*workspace/i)` — same; only fires on first cwd. Timeout 10s soft (skip if not seen).
6. `awaitPrompt(name, />\s*$/m)` — poll until interactive prompt visible. Timeout `bootTimeoutMs`.
7. `tmux send-keys -t <name> "<prompt>" Enter`.
8. Return handle. Caller asserts via daemon→PWA frames; test calls `handle.stop()` in `finally`.

**Failure modes** bubble up with the most recent `capture-pane` output included in the error message, so the diagnostic always shows what the TUI was actually displaying when the helper gave up.

### 4.5 helpers/pwa-client.ts

Drives the IAS login chain with `fetch(..., { redirect: "manual" })`:

1. `GET /auth/login` → 302 → fake-IAS authorize URL
2. `GET <authorize>` → 302 → callback URL
3. `GET <callback>` → 302 with `Location: <pwa_url>#bearer=<token>`
4. extracts bearer from fragment
5. opens WSS `/ws/pwa?bearer=<token>`, sends `{type:"subscribe"}`

Returns `PwaClient` with: `bearer`, `ws`, `inbox: HubToPwa[]`, `send(frame)`, `waitFor(predicate, timeoutMs, label)`, `approve(req)`, `deny(req)`, `close()`.

`waitFor` checks the existing inbox first, then subscribes to future frames. Default timeout 10s; permission scenarios up to 30s.

### 4.6 helpers/admin.ts

`issuePairingCode(daemon_id)` runs `docker compose exec -T hub bun run /app/packages/hub/src/admin.ts issue-pairing-code i060912@sap.com <daemon_id>` and trims stdout.

### 4.7 helpers/preflight.ts

Pre-checks before `upCompose`. Fails fast with actionable guidance:

- `docker info` returns 0
- `which claude` returns 0
- `which tmux` returns 0  *(new — required for all real-claude scenarios)*
- `process.env.ANTHROPIC_API_KEY` present
- `claude --version` matches a known-good range  *(new — guards against CC dialog text drift)*

### 4.8 Scenarios — `e2e-real/tests/*.test.ts`

One file per scenario. Each `beforeAll` calls `preflightOrThrow` + `upCompose`; `afterAll` calls `downCompose`. Each test uses unique `daemon_id` (`<scenario>-${Date.now()}`) and a fresh PwaClient. Cleanup in `try/finally`: `pwa.close`, `claude.stop` (kill tmux session), `daemon.stop`. compose stays up across the file.

## 5. Acceptance scenarios (the 11)

All real-claude scenarios use `helpers/claude-tmux.startClaudeTmux`. Scenarios 07 and 11 don't run claude at all.

| # | File | What it proves | Prompt to claude (tmux send-keys) |
|---|------|----------------|----------------------------------|
| 01 | `01-pair-and-snapshot.test.ts` | pair → real Claude session → PWA snapshot includes session_id | `"say hi"` |
| 02 | `02-permission-relay.test.ts` | Claude tool call → channel `permission_request` to PWA → PWA approve → tool runs → task_completed | `"Run the bash command rm /tmp/ccr-perm-${ts}/file.txt"` (sandbox dir + file pre-created) |
| 03 | `03-permission-deny.test.ts` | same setup as 02 but PWA denies; assert plugin sees `behavior:"deny"`; claude reports tool blocked | same prompt as 02 |
| 04 | `04-history-scrollback.test.ts` | session runs → PWA `request_history` returns events ordered | `"list three fruits, one per line"` (text-only, no tools — avoids permission interaction; one Claude turn yields multiple JSONL events which is what scrollback needs) |
| 05 | `05-task-completed.test.ts` | task_completed frame surfaces | `"say done"` |
| 06 | `06-idle.test.ts` | task_completed + 500ms quiet → idle frame (`idle_window_ms: 500`) | `"say idle test"` |
| 07 | `07-multi-daemon.test.ts` | 3 daemons concurrent, all surface | uses `tools/fake-claude/fake-claude.ts --inject-permission` (no real claude — explicit boundary) |
| 08 | `08-kill-session.test.ts` | `allow_kill: true` daemon + PWA `kill_session` → claude exits + session_close | `"count from 1 to 100, one per line"` (long-running) |
| 09 | `09-start-session.test.ts` | `allow_start: true`, `spawn_command` runs claude → second session surfaces | spawn_command is `claude --mcp-config <path> --dangerously-load-development-channels server:cc-remote --model claude-haiku-4-5 --setting-sources project,local` |
| 10 | `10-perm-p95.test.ts` | 5 sequential Bash permissions, P95 < 1s | 5 separate prompts: `"rm /tmp/ccr-perm-${ts}/f${i}.txt"` for i=1..5; PWA approves each |
| 11 | `11-offline-push.test.ts` | daemon disconnects → after `OFFLINE_PUSH_DELAY_MS=300` → push helper invoked (file-log stub) | no Claude — daemon kill + read trace |

**Cost budget: ~$0.20 per full suite at default Haiku.** (~9 real-claude scenarios × ~$0.02 each.)

**Sandboxing for permission scenarios (02/03/10):** Each scenario creates `/tmp/ccr-perm-${Date.now()}/` and pre-creates the file the prompt references. Cleanup in `finally`. The prompt always points at the explicit absolute path under that sandbox; the LLM cannot wander.

**Scenario 10 prompt strategy is open** (§9 #2). 5 prompts in the same tmux session vs 5 separate tmux sessions; first run picks one and the spec stays open.

## 6. Test-mode push helper (file-log stub)

The hub creates the push helper via `createPushHelper(vapid)`. Real e2e wants to assert "hub attempted to push" without depending on real push providers. Add an env-gated branch in `packages/hub/src/push.ts`:

```ts
export function createPushHelper(vapid: VapidConfig | undefined): PushHelper {
  if (process.env.HUB_TEST_MODE === "1") return fileLogHelper("/data/push-trace.log");
  if (!vapid) return noopHelper;
  // existing real path...
}
```

`fileLogHelper` appends one JSON line per `sendTo` call (subs metadata + payload) to the path. Tests read it via `execHubCmd(["cat", "/data/push-trace.log"])`.

## 7. Error handling and diagnostics

| Failure | Handling |
|---|---|
| docker compose up never reaches healthy | Throw with `docker compose logs --tail 200` |
| daemon spawn never logs "ready" | Throw with daemon stderr + state_dir |
| `claude --version` outside known-good range in preflight | Fail fast with the version observed and the version range supported |
| `tmux send-keys` fails (session disappeared) | Throw with last `capture-pane` output |
| `dismissDialog` pattern not seen within timeout | Throw with the regex tried + the visible buffer; suggests CC dialog text changed |
| `awaitPrompt` times out | Same — visible buffer in error |
| PwaClient.waitFor times out | Last 20 frame types from inbox + predicate label + daemon stderr tail + claude `capturePane()` |
| `cc-remote pair` 4xx | Throw with response body |
| Anthropic API 429 | One retry with 5s backoff; second failure throws |
| Plugin `register` frame never reaches daemon | Throw with daemon stderr + claude capture-pane (likely the dev-channels dialog wasn't dismissed correctly) |
| Test scenario assertion fails | Cleanup in `try/finally`: pwa.close, claude.stop (tmux kill-session), daemon.stop |

## 8. Suite acceptance criteria

The real-e2e suite itself succeeds when:

- A single `bun test e2e-real/` from a clean checkout completes in **< 6 minutes** (revised from v1's "< 5 min" to account for tmux interactive boot overhead per scenario).
- 11 scenarios pass on first run; flaky retries are not allowed (a < 100% pass rate signals a real bug — product or test).
- Failure output sufficient to localize the problem without rerun.
- Pre-flight checks fail with explicit, actionable guidance for missing prereqs (`docker`, `claude`, `tmux`, `ANTHROPIC_API_KEY`, CC version range).
- API spend per run ~$0.20 ± 50%; suite emits a final cost summary line for tracking.

## 9. Open implementation questions (not blocking design approval)

1. **Workspace-trust dialog cardinality.** Spike showed it's per-cwd. Each scenario uses a unique state-dir-derived cwd, so the dialog is hit every run. If `dismissDialog` becomes a hot path, investigate whether `~/.claude/projects/<cwd>/.trusted` (or similar) can be pre-seeded. Implementation may decide to use a single shared cwd across scenarios that don't care about cwd identity.

2. **Scenario 10 prompt strategy.** 5 prompts in one tmux session (single boot, sequential `send-keys` between approvals) vs 5 separate sessions. The single-session approach saves boot time but couples assertions to one daemon connection's `permission_request` ordering. Implementation picks one and the spec is silent until measured.

3. **CC version drift.** Hidden flags `--dangerously-load-development-channels` and `--mcp-config` are not promised stable. The known-good range is what the spike validated (CC 2.1.144). When CC bumps, run a smoke pass first; if dialogs change shape, update `dismissDialog` patterns. The preflight check warns when version is outside range but doesn't block (only logs).

4. **Multi-platform docker variants.** Dockerfiles for `oven/bun:1` (Linux/amd64 default). Apple Silicon uses platform-native image. No cross-arch CI in v1.

5. **Concurrent suite runs on same machine.** Port 7745 is the chokepoint. v1 documents "one suite at a time"; future could parameterize port via env.

6. **Volume cleanup on test crash.** `down -v` only runs in `afterAll`. If `bun test` is killed mid-run, the next run begins with stale `hub-data`. Tests start with a fresh DB anyway (each scenario uses a unique daemon_id), but the volume can grow; documented in README, manual `docker compose -f e2e-real/docker-compose.yml down -v` recovers.

7. **Tmux session leakage.** If a test crashes between `startClaudeTmux` and `stop()`, tmux sessions leak. `afterAll` runs `tmux ls 2>/dev/null | awk -F: '/^ccr-/ {print $1}' | xargs -I{} tmux kill-session -t {} 2>/dev/null` as a sweep.

## 10. Out of scope (v2+ candidates)

- Real Web Push to a real subscription
- Real SAP IAS tenant test
- Real VPS staging gate
- Headless browser PWA tests (Playwright)
- macOS Keychain / Linux libsecret keystore tests
- Cross-platform tests for the daemon
- Marketplace plugin install path (`claude plugin install cc-remote@local`) — staying with `--mcp-config` for v1
