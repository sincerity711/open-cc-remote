# Real-component e2e suite — Implementation Plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Each task carries TDD-style steps: write the test (or failing assertion harness), make it pass, commit. Mark `- [x]` as you go.

**Goal:** Build the new `e2e-real/` test suite that exercises the v1 acceptance checklist against real components — real hub binary in docker, real `cc-remote daemon` on host, real `claude` driven through tmux interactive mode, scripted PWA-equivalent client. Source of truth: `docs/superpowers/specs/2026-05-19-real-e2e-design.md` (rewritten 2026-05-20).

**Supersedes:** `docs/superpowers/plans/2026-05-19-real-e2e-plan.SUPERSEDED.md`. The old plan was written before the plugin MCP rework and assumed `--channels plugin:cc-remote@local` (no longer exists in CC 2.1.143+) plus a Path B (CC_REMOTE_FAKE_PERMISSION) fallback for permission scenarios. Both assumptions are obsolete; the rewritten spec uses tmux interactive + `--mcp-config` for full Path A coverage.

**Architecture summary:** docker compose runs hub + fake-IAS containers. Daemon, Claude Code (under tmux), and the PWA-equivalent test driver run on host. Each scenario writes a Bun test that orchestrates these components, drives a real flow, asserts on observable outcomes. Hub gains one env-gated branch (`HUB_TEST_MODE=1`) that swaps the Web Push delivery layer for a file-log stub.

**Tech Stack:** Bun runtime, docker / docker compose, `oven/bun:1` base images, real `claude` 2.1.144+ on host, tmux on host, existing `@cc-remote/proto` + `@cc-remote/hub` workspace packages, Anthropic API for real Claude turns (default `claude-haiku-4-5-20251001`).

---

## File map

```
docs/superpowers/specs/2026-05-19-real-e2e-design.md           ← (rewritten 2026-05-20, source of truth)
docs/superpowers/plans/2026-05-20-real-e2e-plan.md             ← (this file)
docs/superpowers/research/channel-permission-protocol.md       ← (still valid; marked superseded section ignored)
docs/superpowers/research/2026-05-20-p-mode-permission-spike.md ← (T0 spike output)

e2e-real/
├── package.json
├── tsconfig.json
├── README.md
├── docker-compose.yml
├── .dockerignore
├── fixtures/
│   ├── hub.dockerfile
│   └── fake-ias.dockerfile
├── helpers/
│   ├── compose.ts        — upCompose, downCompose, execHubCmd
│   ├── preflight.ts      — checks docker, claude, tmux, ANTHROPIC_API_KEY, claude version
│   ├── admin.ts          — issuePairingCode via `docker compose exec hub`
│   ├── daemon.ts         — startDaemon, pairDaemon
│   ├── claude-tmux.ts    — startClaudeTmux (single entry point for real claude)
│   ├── tmux.ts           — low-level tmux primitives (newSession, sendKeys, capturePane, killSession, listCcrSessions)
│   └── pwa-client.ts     — loginAndConnect, waitFor, approve, deny
└── tests/
    ├── 01-pair-and-snapshot.test.ts
    ├── 02-permission-relay.test.ts
    ├── 03-permission-deny.test.ts
    ├── 04-history-scrollback.test.ts
    ├── 05-task-completed.test.ts
    ├── 06-idle.test.ts
    ├── 07-multi-daemon.test.ts                 (uses fake-claude --inject-permission, not real claude)
    ├── 08-kill-session.test.ts
    ├── 09-start-session.test.ts
    ├── 10-perm-p95.test.ts
    └── 11-offline-push.test.ts

packages/hub/src/push.ts                        ← MODIFIED in Task 4 (HUB_TEST_MODE branch)
packages/hub/src/index.ts                       ← MODIFIED in Task 12 (HUB_OFFLINE_PUSH_DELAY_MS env)
packages/hub/src/routes.ts                      ← MODIFIED in Task 12 (forward offline_push_delay_ms)
```

Plan-level dependencies:
- Tasks 1–9 establish workspace + helpers + push stub + preflight (gate everything else)
- Task 10 (scenario 01) is the smoke test that validates the whole chain end-to-end
- Tasks 11–18 each add one scenario file (or a small cluster)
- Task 19 is final verification (full suite passes < 6 min, typecheck clean, README updated, tag)

---

## Task 1: e2e-real workspace skeleton

**Files:**
- Create: `e2e-real/package.json`
- Create: `e2e-real/tsconfig.json`
- Create: `e2e-real/README.md`
- Modify: `package.json` (root)

- [ ] **Step 1: Create `e2e-real/package.json`**
```json
{
  "name": "@cc-remote/e2e-real",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "bun test tests/",
    "compose:up": "docker compose -f docker-compose.yml up -d --wait",
    "compose:down": "docker compose -f docker-compose.yml down -v",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@cc-remote/proto": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "bun-types": "latest"
  }
}
```

- [ ] **Step 2: Create `e2e-real/tsconfig.json`**
```json
{ "extends": "../tsconfig.base.json", "include": ["helpers/**/*", "tests/**/*"] }
```

- [ ] **Step 3: Create `e2e-real/README.md`**
- Title: `@cc-remote/e2e-real`
- Sections: What runs / Prerequisites / Run / Cost / Boundary
- Prereqs table: docker daemon, `claude` on PATH, `tmux` on PATH, `ANTHROPIC_API_KEY`, claude version range
- Run: `bun install && cd e2e-real && bun run test`
- Cost: ~$0.20 per full suite at default Haiku
- Boundary: pointer to spec §10

- [ ] **Step 4: Update root `package.json` workspaces**
Replace `"workspaces": ["packages/*"]` → `"workspaces": ["packages/*", "e2e-real"]`.

- [ ] **Step 5: Verify**
```bash
bun install && bun run --filter=@cc-remote/e2e-real typecheck
```
Both succeed (typecheck has no source yet).

- [ ] **Step 6: Commit**
```
feat(e2e-real): scaffold workspace
```

---

## Task 2: Dockerfiles and docker-compose

**Files:**
- Create: `e2e-real/fixtures/hub.dockerfile`
- Create: `e2e-real/fixtures/fake-ias.dockerfile`
- Create: `e2e-real/docker-compose.yml`
- Create: `e2e-real/.dockerignore`

- [ ] **Step 1: `hub.dockerfile`** — `FROM oven/bun:1`, `WORKDIR /app`, copy `package.json bun.lock packages/proto packages/hub`, `bun install --frozen-lockfile`, `mkdir -p /data`, `EXPOSE 7745`, `CMD ["bun", "run", "/app/packages/hub/src/index.ts"]`.

- [ ] **Step 2: `fake-ias.dockerfile`** — same base, copy `tools/fake-ias`, install, expose 7770, run `tools/fake-ias/fake-ias.ts`.

- [ ] **Step 3: `docker-compose.yml`** — two services per spec §4.1:
  - `fake-ias` with healthcheck on `/.well-known/openid-configuration`
  - `hub` depending on fake-ias healthy, env: `HUB_PORT=7745`, `HUB_DB_PATH=/data/hub.sqlite`, `HUB_JWT_SECRET=e2e-test-secret-not-for-prod`, `HUB_PWA_URL=http://localhost:7745/`, `HUB_IAS_ISSUER=http://fake-ias:7770`, `HUB_IAS_CLIENT_ID=cc-remote`, `HUB_IAS_CLIENT_SECRET=test-secret`, `HUB_IAS_REDIRECT_URI=http://localhost:7745/auth/callback`, `HUB_IAS_ALLOWED_SUBJECTS=i060912@sap.com`, `HUB_TEST_MODE=1`, `HUB_OFFLINE_PUSH_DELAY_MS=300`. Port 7745:7745. Volume `hub-data:/data`. Healthcheck on `/healthz`.

- [ ] **Step 4: `.dockerignore`** — ignore `node_modules`, `**/dist`, `**/.git`, `docs`, `e2e`, `e2e-real`, `tools/fake-claude` (not needed in hub image).

- [ ] **Step 5: Verify build**
```bash
cd e2e-real && docker compose build
```
Both images build (1–3 min first run).

- [ ] **Step 6: Commit**
```
feat(e2e-real): docker compose hub + fake-ias
```

---

## Task 3: helpers/compose.ts

**Files:**
- Create: `e2e-real/helpers/compose.ts`

- [ ] **Step 1**: Implement `upCompose()`, `downCompose()`, `execHubCmd(argv)` per spec §4.2. On `up` failure, `Error` body must include `docker compose logs --tail 200`.

- [ ] **Step 2**: Verify typecheck.

- [ ] **Step 3: Commit** — `feat(e2e-real): helpers/compose`

---

## Task 4: HUB_TEST_MODE file-log push stub (production code change)

**Files:**
- Modify: `packages/hub/src/push.ts`
- Modify (extend): `packages/hub/tests/push.test.ts`

- [ ] **Step 1: Add `fileLogHelper(path)`** in `push.ts`. Appends `JSON.stringify({ts, subs: subs.map(s=>s.device_id), payload}) + "\n"` per `sendTo`. `mkdirSync(dirname(path), {recursive: true})` first; tolerate write errors with stderr warning (do not throw).

- [ ] **Step 2: Modify `createPushHelper(vapid)`** to early-return `fileLogHelper(process.env.HUB_PUSH_TRACE_PATH ?? "/data/push-trace.log")` when `HUB_TEST_MODE === "1"`. Preserve all other paths verbatim.

- [ ] **Step 3 (TDD): Add test** in `packages/hub/tests/push.test.ts` — `createPushHelper returns file-log stub when HUB_TEST_MODE=1`. mkdtempSync, set env, sendTo with `kind: "permission"` payload, read file, expect 1 line, parsed `subs == ["d1"]`, `payload.kind == "permission"`. Cleanup env + dir in finally.

- [ ] **Step 4: Run hub tests**
```bash
bun test packages/hub
```
Existing + new test pass.

- [ ] **Step 5: Commit** — `feat(hub): HUB_TEST_MODE file-log push stub`

---

## Task 5: helpers/admin.ts

**Files:**
- Create: `e2e-real/helpers/admin.ts`

- [ ] **Step 1: `issuePairingCode(daemon_id, owner_sub = "i060912@sap.com")`** via `execHubCmd(["bun", "run", "/app/packages/hub/src/admin.ts", "issue-pairing-code", owner_sub, daemon_id])`. Trim stdout.

- [ ] **Step 2: typecheck**

- [ ] **Step 3: Commit** — `feat(e2e-real): helpers/admin`

---

## Task 6: helpers/daemon.ts

**Files:**
- Create: `e2e-real/helpers/daemon.ts`

- [ ] **Step 1: Define types**
```ts
export interface DaemonOpts {
  daemon_id: string;
  hub_url: string;
  allow_kill?: boolean;
  allow_start?: boolean;
  allowed_cwd_prefix?: string[];
  spawn_command?: string;
  idle_window_ms?: number;
}
export interface DaemonHandle {
  daemon_id: string;
  state_dir: string;
  socket_path: string;          // <state_dir>/daemon.sock
  proc: ChildProcess;
  stderr(): string;
  stop(): Promise<void>;
}
```

- [ ] **Step 2: `startDaemon(opts)`** — mkdtemp under `tmpdir()`, write `config.json` with all opts, spawn `bun run packages/daemon/src/index.ts` with `CC_REMOTE_STATE_DIR=<state_dir>`. Buffer stdout+stderr. Poll for `"ready"` keyword in either, max 5s. On timeout: SIGKILL, rm state_dir, throw with both buffers.

- [ ] **Step 3: `pairDaemon({state_dir, hub_url, code, daemon_id})`** — `spawnSync` `bun run packages/daemon/bin/cc-remote.ts pair --hub <url> --code <code> --daemon-id <id>` with `CC_REMOTE_STATE_DIR=state_dir`. Throw on non-zero status with stderr.

- [ ] **Step 4: typecheck**

- [ ] **Step 5: Commit** — `feat(e2e-real): helpers/daemon`

---

## Task 7: helpers/tmux.ts (low-level primitives)

**Files:**
- Create: `e2e-real/helpers/tmux.ts`

- [ ] **Step 1: Implement primitives**
```ts
export function newSession(name: string, cwd: string): void;          // tmux new-session -d -s <name> -c <cwd> -x 200 -y 50
export function sendKeys(name: string, text: string, withEnter: boolean = true): void;
export function capturePane(name: string): string;                    // tmux capture-pane -t <name> -p
export function hasSession(name: string): boolean;                    // tmux has-session -t <name>; returns boolean
export function killSession(name: string): void;                      // tmux kill-session -t <name>; ignore if absent
export function listCcrSessions(): string[];                          // tmux ls; filter names starting "ccr-"
export async function waitForPattern(name: string, re: RegExp, timeoutMs: number, label: string): Promise<string>;
                                                                       // polls capturePane every 250ms; throws on timeout with last buffer
```

- [ ] **Step 2: TDD test** at `e2e-real/tests/_helpers/tmux.test.ts` — verifies `newSession + sendKeys "echo hello" + waitForPattern /hello/ + killSession` cycle works on a real shell. Skipped if `tmux` not on PATH (this test is a self-test of the helper, not a scenario).

- [ ] **Step 3: Commit** — `feat(e2e-real): helpers/tmux primitives`

---

## Task 8: helpers/claude-tmux.ts

**Files:**
- Create: `e2e-real/helpers/claude-tmux.ts`

Implements the single entry point for launching real Claude Code under tmux per spec §4.4.

- [ ] **Step 1: Define types** — `StartClaudeTmuxOpts`, `ClaudeTmuxHandle` per spec §4.4.

- [ ] **Step 2: Implement `startClaudeTmux(opts)`** — sequence:
  1. Check `process.env.ANTHROPIC_API_KEY` (via `opts.apiKey`); throw fail-fast if missing
  2. Write MCP config JSON to `opts.mcpConfigPath`:
     ```json
     { "mcpServers": { "cc-remote": {
         "command": "bun",
         "args": ["run", "<pluginEntryPath>"],
         "env": { "CC_REMOTE_SOCKET": "<socketPath>" }
     } } }
     ```
  3. `tmux.newSession(opts.sessionName, opts.cwd)`
  4. Compose claude command: `ANTHROPIC_API_KEY=... claude --mcp-config <mcpConfigPath> --dangerously-load-development-channels server:cc-remote --model <model> --setting-sources project,local`
  5. `tmux.sendKeys(name, command, true)`
  6. `dismissDialog(name, /Allow.*development.*channels/i, 10_000)` — uses `waitForPattern` with shorter timeout, on match `sendKeys(name, "", true)` (just Enter)
  7. `dismissDialog(name, /trust.*workspace/i, 10_000, soft=true)` — soft means timeout doesn't throw (workspace trust may already be remembered)
  8. `waitForPattern(name, /(?:^|\n)\s*>\s*$/m, opts.bootTimeoutMs ?? 15_000, "interactive prompt")`
  9. `tmux.sendKeys(name, opts.prompt, true)`
  10. Return `{ sessionName, capturePane: () => tmux.capturePane(name), stop: () => tmux.killSession(name), isAlive: () => tmux.hasSession(name) }`

- [ ] **Step 3: TDD smoke test** at `e2e-real/tests/_helpers/claude-tmux.test.ts` — skipped without `ANTHROPIC_API_KEY`. Spawns a no-op mock daemon (in-process Bun Unix socket server that ack-allows `permission_request`), calls `startClaudeTmux({ prompt: "say hi" })`, asserts the mock daemon receives a `register` frame within 30s. Cleanup: handle.stop().

- [ ] **Step 4: Commit** — `feat(e2e-real): helpers/claude-tmux`

---

## Task 9: helpers/pwa-client.ts + helpers/preflight.ts

**Files:**
- Create: `e2e-real/helpers/pwa-client.ts`
- Create: `e2e-real/helpers/preflight.ts`

- [ ] **Step 1: `loginAndConnect({hub_http, hub_ws})`** — drive the IAS chain per spec §4.5. Three `fetch(..., {redirect:"manual"})` hops, extract bearer from `#bearer=...` fragment, open WSS with `?bearer=...`, send `{type:"subscribe"}`. Return `PwaClient` with `bearer, ws, inbox, send, waitFor, approve, deny, close`.

- [ ] **Step 2: `waitFor(predicate, timeoutMs=10000, label)`** — check existing inbox first, then subscribe to future frames. On timeout: error message includes last 20 frame `type` values and `label`.

- [ ] **Step 3: `preflight()` and `preflightOrThrow()`** per spec §4.7:
  - `docker info` returns 0
  - `which claude` returns 0
  - `which tmux` returns 0
  - `process.env.ANTHROPIC_API_KEY` set
  - `claude --version` parses to a semver in known-good range (`>=2.1.144`); soft warn if outside range, do not throw

- [ ] **Step 4: typecheck**

- [ ] **Step 5: Commit** — `feat(e2e-real): helpers/pwa-client + preflight`

---

## Task 10: Scenario 01 — pair and snapshot (smoke for whole infrastructure)

**Files:**
- Create: `e2e-real/tests/01-pair-and-snapshot.test.ts`

- [ ] **Step 1: Write failing test**
```ts
test("real Claude session pairs and shows up in PWA snapshot", async () => {
  const daemon_id = `pair-snap-${Date.now()}`;
  const code = issuePairingCode(daemon_id);
  const d1 = await startDaemon({ daemon_id, hub_url: "ws://localhost:7745" });
  pairDaemon({ state_dir: d1.state_dir, hub_url: "http://localhost:7745", code, daemon_id });
  await d1.stop();
  const daemon = await startDaemon({ daemon_id, hub_url: "ws://localhost:7745" });
  const pwa = await loginAndConnect({ hub_http: "http://localhost:7745", hub_ws: "ws://localhost:7745" });
  const sessionName = `ccr-pair-${daemon_id}`;
  const claude = await startClaudeTmux({
    cwd: "/tmp",
    prompt: "say hi",
    sessionName,
    socketPath: daemon.socket_path,
    mcpConfigPath: `${daemon.state_dir}/cc-remote-mcp.json`,
    pluginEntryPath: resolve(import.meta.dir, "../../packages/plugin/src/index.ts"),
  });
  try {
    const opened = await pwa.waitFor((f) => {
      if (f.type === "session_open" && f.daemon_id === daemon_id) return f;
      if (f.type === "snapshot") {
        for (const d of f.daemons) {
          if (d.daemon_id === daemon_id && d.sessions.length > 0) return f;
        }
      }
      return false;
    }, 30_000, "session_open or snapshot containing this daemon's session");
    expect(opened).toBeTruthy();
  } finally {
    pwa.close();
    claude.stop();
    await daemon.stop();
  }
}, 120_000);
```
- [ ] **Step 2: Run** — `bun test e2e-real/tests/01-pair-and-snapshot.test.ts`. Expected: PASS in 30–60s after first compose build.
- [ ] **Step 3: If failing** — typical issues: dialog regex mismatch (capture-pane has different text → update `claude-tmux` regex with the observed text and rerun), `ANTHROPIC_API_KEY` missing (preflight should catch), daemon socket path mismatch.
- [ ] **Step 4: Commit** — `test(e2e-real): 01 pair + real claude snapshot`

---

## Task 11: Scenario 07 — multi-daemon (fake-claude — no real claude)

**Files:**
- Create: `e2e-real/tests/07-multi-daemon.test.ts`

- [ ] **Step 1**: 3 unique daemon_ids; each pairs and starts. For each, spawn `tools/fake-claude/fake-claude.ts --session-id s-<id> --cwd /tmp/<id> --socket <state_dir>/daemon.sock`. Wait for PWA to see all 3 sessions via `snapshot` or `session_open` per daemon.

- [ ] **Step 2: Run** — expected PASS.

- [ ] **Step 3: Commit** — `test(e2e-real): 07 multi-daemon (fake-claude)`

---

## Task 12: Hub config plumbing for offline-push delay (production code)

**Files:**
- Modify: `packages/hub/src/index.ts`
- Modify: `packages/hub/src/routes.ts`
- Possibly modify: `packages/hub/tests/routes.test.ts` (if it asserts on opts shape)

- [ ] **Step 1**: Add `offline_push_delay_ms?: number` to `MakeServerOpts` in `routes.ts`. Pass through to `new Router(...)` constructor's options arg.

- [ ] **Step 2**: In `index.ts`, read `process.env.HUB_OFFLINE_PUSH_DELAY_MS`, parse as number (undefined if unset), forward to `makeServer(...)`.

- [ ] **Step 3**: Run `bun test packages/hub`. Existing tests must pass; touch `routes.test.ts` only if its types break.

- [ ] **Step 4: Commit** — `feat(hub): HUB_OFFLINE_PUSH_DELAY_MS env plumbing`

---

## Task 13: Scenario 11 — daemon-offline push (file-log stub)

**Files:**
- Create: `e2e-real/tests/11-offline-push.test.ts`

Note: docker-compose.yml already sets `HUB_OFFLINE_PUSH_DELAY_MS=300` (Task 2 step 3).

- [ ] **Step 1: Test sequence**:
  1. pair daemon, restart paired
  2. PWA login + connect
  3. `POST /push/subscribe` with bearer (fake endpoint+keys) → 204
  4. `PUT /push/preferences {offline: true}` → 204
  5. wait `daemon_online`
  6. daemon.stop()
  7. poll `execHubCmd(["sh", "-c", "cat /data/push-trace.log 2>/dev/null || true"])` up to 5s, parse each line, look for `payload.kind === "offline"` and `payload.daemon_id === daemon_id`
  8. assert found

- [ ] **Step 2: Rebuild hub image** (modified in Task 12):
```bash
cd e2e-real && docker compose build hub
```

- [ ] **Step 3: Run + Commit**
```
test(e2e-real): 11 offline-push trace
```

---

## Task 14: Scenario 05 + 06 — task_completed + idle (real claude, text-only prompts)

These two are bundled because they share setup and prompts that don't trigger tools.

**Files:**
- Create: `e2e-real/tests/05-task-completed.test.ts`
- Create: `e2e-real/tests/06-idle.test.ts`

- [ ] **05 Step 1**: Standard pair → restart → connect PWA → startClaudeTmux({prompt: "say done"}). `waitFor(f => f.type === "task_completed" && f.daemon_id === daemon_id, 60_000)`. Assert truthy.

- [ ] **06 Step 1**: Same as 05 but `idle_window_ms: 500` on daemon, prompt `"say idle test"`. After `task_completed`, `waitFor(f => f.type === "idle" && f.daemon_id === daemon_id, 5_000)`.

- [ ] **Step 2: Commit each separately**
```
test(e2e-real): 05 task_completed (real claude)
test(e2e-real): 06 idle (real claude)
```

---

## Task 15: Scenario 04 — history scrollback (real claude, text-only)

**Files:**
- Create: `e2e-real/tests/04-history-scrollback.test.ts`

- [ ] **Step 1**: pair → restart → connect → startClaudeTmux({prompt: "list three fruits, one per line"}). Wait `session_open` → extract `session_id` → wait `task_completed`. Then `pwa.send({type:"request_history", daemon_id, session_id, request_id:"rh-test", before_offset: Number.MAX_SAFE_INTEGER, limit: 100})`. `waitFor(f.type === "history_chunk" && f.request_id === "rh-test", 10_000)`. Assert `events.length > 0`.

- [ ] **Step 2: Commit** — `test(e2e-real): 04 history scrollback`

---

## Task 16: Permission scenarios — 02, 03, 10 (Path A end-to-end)

**Files:**
- Create: `e2e-real/tests/02-permission-relay.test.ts`
- Create: `e2e-real/tests/03-permission-deny.test.ts`
- Create: `e2e-real/tests/10-perm-p95.test.ts`

These are the highlight of the suite — they exercise the real channel-permission protocol.

**Sandbox setup (shared helper):**
```ts
function setupPermSandbox(scenario: string): { dir: string; files: string[]; cleanup: () => void };
```
Creates `/tmp/ccr-perm-${scenario}-${Date.now()}/` and pre-creates files (`f1.txt`, `f2.txt`, ...). Returns `cleanup` that `rm -rf`s the dir.

- [ ] **02 Step 1: Test**
```ts
const sandbox = setupPermSandbox("relay");
try {
  // ... pair, restart, connect ...
  const claude = await startClaudeTmux({
    cwd: sandbox.dir,
    prompt: `Run the bash command: rm ${sandbox.files[0]}`,
    sessionName, socketPath, mcpConfigPath, pluginEntryPath
  });
  const req = await pwa.waitFor((f) => {
    if (f.type === "permission_request" && f.daemon_id === daemon_id) return f;
    return false;
  }, 30_000, "permission_request");
  expect((req as any).request_id).toMatch(/^[a-km-z]{5}$/);
  pwa.approve(req as any);
  const resolved = await pwa.waitFor((f) => {
    if (f.type === "permission_resolved" && (f as any).request_id === (req as any).request_id) return f;
    return false;
  }, 10_000, "permission_resolved");
  expect((resolved as any).decision).toBe("allow");
  // Optionally wait for task_completed to confirm tool actually ran
  await pwa.waitFor((f) => f.type === "task_completed" && f.daemon_id === daemon_id, 60_000, "task_completed");
} finally {
  pwa.close(); claude.stop(); await daemon.stop(); sandbox.cleanup();
}
```

- [ ] **03 Step 1**: same but `pwa.deny(req)` → assert `permission_resolved.decision === "deny"`. Tool blocked; claude may produce a follow-up explaining it can't proceed; we don't assert on text, only on the protocol round-trip.

- [ ] **10 Step 1: P95 measurement**:
```ts
const sandbox = setupPermSandbox("p95");  // pre-creates 5 files
const latencies: number[] = [];
const claude = await startClaudeTmux({ cwd: sandbox.dir, prompt: "(no-op, awaiting prompts)", ... });  // initial empty boot
for (let i = 0; i < 5; i++) {
  tmux.sendKeys(sessionName, `Run the bash command: rm ${sandbox.files[i]}`, true);
  const sentAt = Date.now();
  const req = await pwa.waitFor((f) => f.type === "permission_request" && f.daemon_id === daemon_id ? f : false, 30_000, `permission_request #${i}`);
  pwa.approve(req as any);
  await pwa.waitFor((f) => f.type === "permission_resolved" && (f as any).request_id === (req as any).request_id ? f : false, 10_000, `permission_resolved #${i}`);
  latencies.push(Date.now() - sentAt);
}
latencies.sort((a, b) => a - b);
const p95 = latencies[Math.ceil(latencies.length * 0.95) - 1];
expect(p95).toBeLessThan(1000);
```
*(Note the prompt-strategy choice — single tmux session with sequential `sendKeys`. If this proves flaky in execution, the alternative is 5 independent `startClaudeTmux` calls. Spec §9 #2.)*

- [ ] **Step 2: Run all three** — expected 3 PASS.

- [ ] **Step 3: Commit each separately**
```
test(e2e-real): 02 permission relay (real protocol Path A)
test(e2e-real): 03 permission deny
test(e2e-real): 10 perm p95
```

---

## Task 17: Scenario 08 — kill_session

**Files:**
- Create: `e2e-real/tests/08-kill-session.test.ts`

- [ ] **Step 1**: daemon with `allow_kill: true`. Prompt `"count from 1 to 100, one per line"` (long-running). Wait `session_open` → grab `session_id` → `pwa.send({type:"kill_session", daemon_id, session_id})`. `waitFor(f.type === "session_close" && session_id matches)`. Then assert `claude.isAlive() === false` (tmux session gone) within 10s. (Note: claude under tmux dies when its tmux session is killed, which the daemon does via SIGKILL. The test verifies this happened by checking tmux session presence.)

- [ ] **Step 2: Commit** — `test(e2e-real): 08 kill_session`

---

## Task 18: Scenario 09 — start_session (daemon-spawned claude)

**Files:**
- Create: `e2e-real/tests/09-start-session.test.ts`

- [ ] **Step 1**: daemon with `allow_start: true`, `allowed_cwd_prefix: [<sandbox>]`, `spawn_command` set to:
```
claude --mcp-config <path> --dangerously-load-development-channels server:cc-remote --model claude-haiku-4-5 --setting-sources project,local -p "say started"
```
*(Subtlety: this uses `-p` because the daemon spawns claude non-interactively under tmux as part of the `start_session` workflow. Permission UI is not exercised here — start_session is about the spawn machinery. The MCP plugin still loads and registers a session via `register` frame, which is what we assert.)*

- [ ] **Step 2**: Generate the MCP config file in the test (per scenario), pass its path in spawn_command. Send `{type:"start_session", daemon_id, cwd: sandbox, name: tmux_session_name}` to PWA. Wait `session_open` for the new session (different `session_id` from any earlier one). Assert.

- [ ] **Step 3: Commit** — `test(e2e-real): 09 start_session`

---

## Task 19: Final verification

- [ ] **Step 1: All hub tests pass**
```bash
bun test packages/
```
Expected: 164+ existing + new push test + new offline_push_delay tweak still green.

- [ ] **Step 2: Full e2e-real suite**
```bash
bun test e2e-real/
```
Expected: 11 scenario files PASS in < 6 minutes.

- [ ] **Step 3: Typecheck across all packages**
```bash
bun run typecheck
```

- [ ] **Step 4: Update root README.md** — add a short "Real-component e2e (`e2e-real/`)" section pointing at `e2e-real/README.md` and the spec.

- [ ] **Step 5: Update `docs/TODO.md`** — move real-e2e from "paused/in-flight" to "done"; mention the new tag.

- [ ] **Step 6: Commit + tag**
```
docs: link real-e2e suite from root README; update TODO
git tag plan-real-e2e
```

---

## Self-Review

**Spec coverage** (against `docs/superpowers/specs/2026-05-19-real-e2e-design.md`):

| Spec section | Plan task |
| --- | --- |
| §3 Architecture | Tasks 1, 2, 3 |
| §4.1 docker-compose | Task 2 |
| §4.2 helpers/compose | Task 3 |
| §4.3 helpers/daemon | Task 6 |
| §4.4 helpers/claude-tmux | Task 8 |
| §4.5 helpers/pwa-client | Task 9 |
| §4.6 helpers/admin | Task 5 |
| §4.7 helpers/preflight | Task 9 |
| §4.8 Scenarios | Tasks 10–18 |
| §5 11 acceptance scenarios | Tasks 10 (01) + 11 (07) + 13 (11) + 14 (05+06) + 15 (04) + 16 (02+03+10) + 17 (08) + 18 (09). 11 scenarios across 9 tasks. |
| §6 file-log push stub | Task 4 |
| §7 Error handling | distributed across helper tasks (3, 6, 7, 8, 9) |
| §8 Suite acceptance criteria | Task 19 |
| §9 Open implementation questions | Documented per-task; #2 (scenario 10 strategy) flagged in Task 16. |

**Type consistency**: `DaemonOpts`/`DaemonHandle` (Task 6) → consumed by Tasks 10–18. `StartClaudeTmuxOpts`/`ClaudeTmuxHandle` (Task 8) → same. `PwaClient` (Task 9) → same.

**Granularity**: 19 tasks. Each task is self-contained with TDD-style steps where applicable. Permission scenarios bundled into Task 16 because they share sandbox helpers.

**Placeholder scan**: no "TBD"/"TODO"/"implement later". Open questions flagged inline (Task 16's prompt strategy ambiguity).

**TDD framing**: applies to production-code tasks (Task 4, Task 12) which write the test alongside the change. Helper tasks (Tasks 3, 6, 7, 8, 9) include self-tests where meaningful (Task 7 for tmux, Task 8 for claude-tmux smoke). Scenario tasks (10, 11, 13–18) are themselves the tests, so the "write failing test, make pass, commit" loop is the natural unit.
