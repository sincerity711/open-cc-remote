# Real-component e2e suite — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a new `e2e-real/` test suite that exercises the v1 acceptance checklist against real components — real hub binary in docker, real `cc-remote daemon` on host, real `claude --channels` invocation, scripted PWA-equivalent client. Complements the existing fast in-process `e2e/` suite.

**Architecture:** docker compose runs hub + fake-IAS containers. Daemon, Claude Code, and the PWA-equivalent test driver run on host. Each scenario writes a Bun test that orchestrates these components, drives a real flow, and asserts on observable outcomes. Hub gains one env-gated branch (`HUB_TEST_MODE=1`) that swaps the Web Push delivery layer for a file-log stub, so we can assert "did push" without a real provider.

**Tech Stack:** Bun runtime, docker / docker compose, `oven/bun:1` base images, real `claude` binary on host, existing `@cc-remote/proto` + `@cc-remote/hub` workspace packages, Anthropic API for real Claude turns (default `claude-haiku-4-5-20251001`).

---

## File map

```
docs/superpowers/specs/2026-05-19-real-e2e-design.md          ← (already written, source of truth)
docs/superpowers/plans/2026-05-19-real-e2e-plan.md            ← (this file)
docs/superpowers/research/channel-permission-protocol.md      ← T0 output

e2e-real/
├── package.json
├── tsconfig.json
├── README.md
├── docker-compose.yml
├── fixtures/
│   ├── hub.dockerfile
│   └── fake-ias.dockerfile
├── helpers/
│   ├── compose.ts        — upCompose, downCompose, execHubCmd
│   ├── preflight.ts      — checks ANTHROPIC_API_KEY, claude on PATH, docker daemon up, plugin registered
│   ├── admin.ts          — issuePairingCode via `docker compose exec hub`
│   ├── daemon.ts         — startDaemon, pairDaemon
│   ├── claude.ts         — startClaude
│   └── pwa-client.ts     — loginAndConnect, waitFor, approve, deny
└── tests/
    ├── 01-pair-and-snapshot.test.ts
    ├── 02-permission-relay.test.ts          (BLOCKED until T0 finishes)
    ├── 03-permission-deny.test.ts           (BLOCKED until T0 finishes)
    ├── 04-history-scrollback.test.ts
    ├── 05-task-completed.test.ts
    ├── 06-idle.test.ts
    ├── 07-multi-daemon.test.ts              (uses fake-claude, not real Claude)
    ├── 08-kill-session.test.ts
    ├── 09-start-session.test.ts
    ├── 10-perm-p95.test.ts                  (BLOCKED until T0 finishes)
    └── 11-offline-push.test.ts

packages/hub/src/push.ts                    ← MODIFIED in T4 (HUB_TEST_MODE branch)
packages/hub/Dockerfile? — none today; created via fixtures/hub.dockerfile
```

Plan-level dependencies:
- T0 (research) gates T13, T14, T15 (the three real-Claude-permission scenarios)
- All scenario tasks depend on T1–T9 (workspace + helpers + push stub + preflight)

---

## Task 0: Channel-permission protocol investigation (research, no code)

**Files:**
- Create: `docs/superpowers/research/channel-permission-protocol.md`

**Goal:** Find out how Claude Code's `--channels` permission relay actually works on the wire. The plugin must reply via a specific format ("y abcde" / "n abcde") for permission grants. We've inferred from the official telegram channel plugin source but never confirmed against Claude Code's actual handler. This investigation either confirms our assumptions or surfaces what we got wrong.

- [ ] **Step 1: Search Anthropic's public documentation**

Run web searches for:
- `Claude Code channels permission protocol`
- `claude --channels plugin permission relay 5-letter code`
- `anthropic claude code channel-permissions docs site:docs.anthropic.com`

Skim hits, capture URLs and the relevant excerpts.

- [ ] **Step 2: Inspect the official telegram channel plugin**

Read `/Users/i060912/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/telegram/server.ts` (already in this repo's neighbor — we read it earlier in brainstorming). Extract the regex `PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i` and trace how it's used: where does the bot reply go (Telegram message? stdout to Claude Code?), what message does Claude Code send the plugin when it wants to ask for permission, and how does the plugin signal "approve" back.

- [ ] **Step 3: Inspect the official discord and imessage plugins**

Same approach. Look for differences in how they receive the permission prompt and how they reply.

- [ ] **Step 4: Try `claude --help` and any related man-pages on the host**

```bash
claude --help 2>&1 | grep -A 5 channels
claude --help-channels 2>&1 || true
```

Capture output; look for protocol references.

- [ ] **Step 5: Write findings document**

Create `docs/superpowers/research/channel-permission-protocol.md` with sections:
- "What we already inferred" (the 5-letter regex, plugin as MCP stdio server, etc.)
- "What we confirmed via official sources" (URLs cited)
- "What is still unknown" (explicit list)
- "Implementation implications" — does our `cc-remote` plugin need to change before scenarios 02/03/10 can be written? If yes, list the changes; if the protocol is fully spec'd by what we've already inferred, say so.

If the protocol turns out to be poorly documented and reverse-engineering would take more than ~1h of agent time, the document concludes with "Fall back: scenarios 02/03/10 use `CC_REMOTE_FAKE_PERMISSION` trigger plus assertion that the plugin emits a permission_request frame; full real-protocol coverage deferred to a future plan."

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/research/channel-permission-protocol.md
git commit -m "research: channel-permission protocol findings"
```

---

## Task 1: e2e-real workspace skeleton

**Files:**
- Create: `e2e-real/package.json`
- Create: `e2e-real/tsconfig.json`
- Create: `e2e-real/README.md`

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
{
  "extends": "../tsconfig.base.json",
  "include": ["helpers/**/*", "tests/**/*"]
}
```

- [ ] **Step 3: Create `e2e-real/README.md`**

```markdown
# @cc-remote/e2e-real

Real-component end-to-end test suite. Complements the fast in-process tests in `../e2e/`.

## What runs

- **hub** in docker (one container)
- **fake-IAS** in docker (one container)
- **`cc-remote daemon`** as a real native process on host
- **`claude --channels plugin:cc-remote@local`** as a real native process on host
- **PWA-equivalent**: scripted WebSocket + HTTP client driven by Bun

## Prerequisites

| | |
| --- | --- |
| Docker daemon running | `docker info` returns successfully |
| `claude` on PATH | `which claude` resolves |
| `ANTHROPIC_API_KEY` in env | for real Claude turns; default model is Haiku, ~$0.05 per full suite |
| Plugin registered with Claude Code | `cc-remote install` was run once on this host (Plan 8) |
| `cc-remote` binary in PATH or invocable as `bun packages/daemon/bin/cc-remote.ts` | tests use the latter form |

## Run

\`\`\`bash
bun install
cd e2e-real
bun run test
\`\`\`

The `compose:up` script in `package.json` brings the docker stack up; tests' `beforeAll` does this automatically. `compose:down` is run after each scenario file finishes via `afterAll` (named volume `hub-data` is wiped between).

## Cost

~$0.05 per full suite (11 scenarios) at default Haiku. Override with `CCR_E2E_MODEL=claude-sonnet-4-6` etc.

## Boundary: what real-e2e does NOT cover

See `docs/superpowers/specs/2026-05-19-real-e2e-design.md` §10.
```

- [ ] **Step 4: Add the new workspace to root `package.json`**

Modify `package.json` (root) — `workspaces` is currently `["packages/*"]`. Update to `["packages/*", "e2e-real"]`.

```json
"workspaces": ["packages/*", "e2e-real"],
```

- [ ] **Step 5: Install + typecheck**

```bash
bun install
bun run --filter=@cc-remote/e2e-real typecheck
```

Expected: install succeeds; typecheck has nothing to type yet (empty include set returns 0).

- [ ] **Step 6: Commit**

```bash
git add e2e-real/ package.json bun.lock
git commit -m "feat(e2e-real): scaffold workspace"
```

---

## Task 2: Dockerfiles and docker-compose

**Files:**
- Create: `e2e-real/fixtures/hub.dockerfile`
- Create: `e2e-real/fixtures/fake-ias.dockerfile`
- Create: `e2e-real/docker-compose.yml`
- Create: `e2e-real/.dockerignore`

- [ ] **Step 1: Create `e2e-real/fixtures/hub.dockerfile`**

This is built from repo root context (so it can copy workspace deps).

```dockerfile
FROM oven/bun:1

WORKDIR /app

# Workspace root and deps
COPY package.json bun.lock /app/

# Workspace packages we need
COPY packages/proto /app/packages/proto
COPY packages/hub /app/packages/hub

RUN bun install --frozen-lockfile

RUN mkdir -p /data

EXPOSE 7745

CMD ["bun", "run", "/app/packages/hub/src/index.ts"]
```

- [ ] **Step 2: Create `e2e-real/fixtures/fake-ias.dockerfile`**

```dockerfile
FROM oven/bun:1

WORKDIR /app

# fake-ias depends on jose which lives in the root devDeps
COPY package.json bun.lock /app/
COPY tools/fake-ias /app/tools/fake-ias

RUN bun install --frozen-lockfile

EXPOSE 7770

CMD ["bun", "run", "/app/tools/fake-ias/fake-ias.ts"]
```

- [ ] **Step 3: Create `e2e-real/docker-compose.yml`**

```yaml
services:
  fake-ias:
    build:
      context: ..
      dockerfile: e2e-real/fixtures/fake-ias.dockerfile
    environment:
      FAKE_IAS_PORT: "7770"
      FAKE_IAS_SUB: "i060912@sap.com"
    expose:
      - "7770"
    healthcheck:
      test: ["CMD", "wget", "-q", "-O-", "http://localhost:7770/.well-known/openid-configuration"]
      interval: 1s
      timeout: 2s
      retries: 30

  hub:
    build:
      context: ..
      dockerfile: e2e-real/fixtures/hub.dockerfile
    depends_on:
      fake-ias:
        condition: service_healthy
    environment:
      HUB_PORT: "7745"
      HUB_DB_PATH: "/data/hub.sqlite"
      HUB_JWT_SECRET: "e2e-test-secret-not-for-prod"
      HUB_PWA_URL: "http://localhost:7745/"
      HUB_IAS_ISSUER: "http://fake-ias:7770"
      HUB_IAS_CLIENT_ID: "cc-remote"
      HUB_IAS_CLIENT_SECRET: "test-secret"
      HUB_IAS_REDIRECT_URI: "http://localhost:7745/auth/callback"
      HUB_IAS_ALLOWED_SUBJECTS: "i060912@sap.com"
      HUB_TEST_MODE: "1"
    ports:
      - "7745:7745"
    volumes:
      - hub-data:/data
    healthcheck:
      test: ["CMD", "wget", "-q", "-O-", "http://localhost:7745/healthz"]
      interval: 1s
      timeout: 2s
      retries: 30

volumes:
  hub-data:
```

- [ ] **Step 4: Create `e2e-real/.dockerignore`**

```
node_modules
**/node_modules
**/dist
**/.git
**/test_results
**/.DS_Store
**/*.log
docs
e2e
e2e-real
```

(Note: e2e-real is excluded from build context since neither image needs it.)

- [ ] **Step 5: Manually verify the compose builds**

```bash
cd e2e-real
docker compose build
```

Expected: both images build. May take 1–3 minutes on first run.

- [ ] **Step 6: Commit**

```bash
git add e2e-real/fixtures/ e2e-real/docker-compose.yml e2e-real/.dockerignore
git commit -m "feat(e2e-real): docker compose hub + fake-ias"
```

---

## Task 3: helpers/compose.ts

**Files:**
- Create: `e2e-real/helpers/compose.ts`

- [ ] **Step 1: Create `e2e-real/helpers/compose.ts`**

```typescript
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";

const COMPOSE_DIR = resolve(import.meta.dir, "..");

export async function upCompose(): Promise<void> {
  const proc = spawn("docker", ["compose", "up", "-d", "--wait"], {
    cwd: COMPOSE_DIR,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderrBuf = "";
  let stdoutBuf = "";
  proc.stderr?.on("data", (b: Buffer) => { stderrBuf += b.toString(); });
  proc.stdout?.on("data", (b: Buffer) => { stdoutBuf += b.toString(); });
  const code = await new Promise<number>((res) => proc.on("exit", (c) => res(c ?? 0)));
  if (code !== 0) {
    // Pull recent logs for diagnostics.
    const logs = spawnSync("docker", ["compose", "logs", "--tail", "200"], {
      cwd: COMPOSE_DIR, encoding: "utf8",
    });
    throw new Error(
      `docker compose up failed (exit ${code}).\nstderr:\n${stderrBuf}\nstdout:\n${stdoutBuf}\nlogs:\n${logs.stdout}\n${logs.stderr}`,
    );
  }
}

export async function downCompose(): Promise<void> {
  const proc = spawn("docker", ["compose", "down", "-v"], {
    cwd: COMPOSE_DIR,
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((res) => proc.on("exit", () => res()));
}

export function execHubCmd(argv: string[]): string {
  const r = spawnSync("docker", ["compose", "exec", "-T", "hub", ...argv], {
    cwd: COMPOSE_DIR, encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(`docker compose exec failed (exit ${r.status}): ${r.stderr}`);
  }
  return r.stdout;
}
```

- [ ] **Step 2: Verify typecheck**

```bash
bun run --filter=@cc-remote/e2e-real typecheck
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add e2e-real/helpers/compose.ts
git commit -m "feat(e2e-real): helpers/compose"
```

---

## Task 4: HUB_TEST_MODE file-log push stub (production code change)

**Files:**
- Modify: `packages/hub/src/push.ts`
- Test: `packages/hub/tests/push.test.ts` (extend)

The hub gets one new env-gated branch. When `HUB_TEST_MODE=1`, `createPushHelper` returns a helper that appends one JSON line per `sendTo` to `/data/push-trace.log` (which is on the docker volume).

- [ ] **Step 1: Read current `packages/hub/src/push.ts`**

Read the file. It currently has `noopHelper` and a real-VAPID branch. We add a third branch.

- [ ] **Step 2: Modify `packages/hub/src/push.ts`**

Add at top with other imports:
```typescript
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
```

Add the helper function below `noopHelper`:

```typescript
function fileLogHelper(path: string): PushHelper {
  try { mkdirSync(dirname(path), { recursive: true }); } catch {}
  return {
    async sendTo(subs, payload) {
      const line = JSON.stringify({ ts: Date.now(), subs: subs.map((s) => s.device_id), payload }) + "\n";
      try { appendFileSync(path, line); } catch (e) {
        process.stderr.write(`fileLogHelper write failed: ${(e as Error).message}\n`);
      }
    },
  };
}
```

Modify `createPushHelper` to check env:

```typescript
export function createPushHelper(vapid: VapidConfig | undefined): PushHelper {
  if (process.env.HUB_TEST_MODE === "1") {
    return fileLogHelper(process.env.HUB_PUSH_TRACE_PATH ?? "/data/push-trace.log");
  }
  if (!vapid) return noopHelper;
  webpush.setVapidDetails(vapid.subject, vapid.public_key, vapid.private_key);
  return {
    async sendTo(subs, payload) {
      // existing implementation unchanged...
    },
  };
}
```

(Reproduce the existing real-VAPID body verbatim.)

- [ ] **Step 3: Add a test for the file-log stub in `packages/hub/tests/push.test.ts`**

Append:

```typescript
test("createPushHelper returns file-log stub when HUB_TEST_MODE=1", async () => {
  const { mkdtempSync, rmSync, readFileSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "ccr-push-"));
  const tracePath = join(dir, "push-trace.log");
  const orig = process.env.HUB_TEST_MODE;
  const origPath = process.env.HUB_PUSH_TRACE_PATH;
  try {
    process.env.HUB_TEST_MODE = "1";
    process.env.HUB_PUSH_TRACE_PATH = tracePath;
    const h = createPushHelper(undefined);
    await h.sendTo(
      [{ device_id: "d1", endpoint: "https://x", p256dh: "p", auth: "a", preferences: { permission: true } }],
      { kind: "permission", message: "test" },
    );
    expect(existsSync(tracePath)).toBe(true);
    const lines = readFileSync(tracePath, "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!) as { subs: string[]; payload: { kind: string } };
    expect(parsed.subs).toEqual(["d1"]);
    expect(parsed.payload.kind).toBe("permission");
  } finally {
    if (orig === undefined) delete process.env.HUB_TEST_MODE; else process.env.HUB_TEST_MODE = orig;
    if (origPath === undefined) delete process.env.HUB_PUSH_TRACE_PATH; else process.env.HUB_PUSH_TRACE_PATH = origPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 4: Run hub tests**

```bash
bun test packages/hub
```

Expected: existing hub tests pass + new test passes.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/push.ts packages/hub/tests/push.test.ts
git commit -m "feat(hub): HUB_TEST_MODE file-log push stub"
```

---

## Task 5: helpers/admin.ts

**Files:**
- Create: `e2e-real/helpers/admin.ts`

- [ ] **Step 1: Create `e2e-real/helpers/admin.ts`**

```typescript
import { execHubCmd } from "./compose.ts";

export function issuePairingCode(daemon_id: string, owner_sub = "i060912@sap.com"): string {
  const out = execHubCmd([
    "bun", "run", "/app/packages/hub/src/admin.ts",
    "issue-pairing-code", owner_sub, daemon_id,
  ]);
  return out.trim();
}
```

- [ ] **Step 2: Verify typecheck**

```bash
bun run --filter=@cc-remote/e2e-real typecheck
```

- [ ] **Step 3: Commit**

```bash
git add e2e-real/helpers/admin.ts
git commit -m "feat(e2e-real): helpers/admin"
```

---

## Task 6: helpers/daemon.ts

**Files:**
- Create: `e2e-real/helpers/daemon.ts`

- [ ] **Step 1: Create `e2e-real/helpers/daemon.ts`**

```typescript
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");

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
  proc: ChildProcess;
  stderr(): string;
  stop(): Promise<void>;
}

export async function startDaemon(opts: DaemonOpts): Promise<DaemonHandle> {
  const state_dir = mkdtempSync(join(tmpdir(), `ccr-e2e-real-${opts.daemon_id}-`));
  const config: Record<string, unknown> = {
    daemon_id: opts.daemon_id,
    hub_url: opts.hub_url,
    allow_kill: opts.allow_kill ?? false,
    allow_start: opts.allow_start ?? false,
    allowed_cwd_prefix: opts.allowed_cwd_prefix ?? [],
  };
  if (opts.spawn_command !== undefined) config.spawn_command = opts.spawn_command;
  if (opts.idle_window_ms !== undefined) config.idle_window_ms = opts.idle_window_ms;
  writeFileSync(join(state_dir, "config.json"), JSON.stringify(config, null, 2));

  const proc = spawn("bun", ["run", join(ROOT, "packages/daemon/src/index.ts")], {
    env: { ...process.env, CC_REMOTE_STATE_DIR: state_dir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderrBuf = "";
  let stdoutBuf = "";
  proc.stderr?.on("data", (b: Buffer) => { stderrBuf += b.toString(); });
  proc.stdout?.on("data", (b: Buffer) => { stdoutBuf += b.toString(); });

  const start = Date.now();
  while (Date.now() - start < 5000) {
    if (stdoutBuf.includes("ready") || stderrBuf.includes("ready")) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  if (!stdoutBuf.includes("ready") && !stderrBuf.includes("ready")) {
    try { proc.kill("SIGKILL"); } catch {}
    rmSync(state_dir, { recursive: true, force: true });
    throw new Error(`daemon ${opts.daemon_id} did not become ready in 5s.\nstderr:\n${stderrBuf}\nstdout:\n${stdoutBuf}`);
  }

  return {
    daemon_id: opts.daemon_id,
    state_dir,
    proc,
    stderr: () => stderrBuf,
    async stop() {
      try { proc.kill("SIGTERM"); } catch {}
      await new Promise<void>((res) => proc.on("exit", () => res()));
      rmSync(state_dir, { recursive: true, force: true });
    },
  };
}

export function pairDaemon(state_dir: string, hub_url: string, code: string): void {
  const r = spawnSync("bun", [
    "run", join(ROOT, "packages/daemon/bin/cc-remote.ts"),
    "pair", "--hub", hub_url, "--code", code, "--daemon-id", basenameForId(state_dir),
  ], { env: { ...process.env, CC_REMOTE_STATE_DIR: state_dir }, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`cc-remote pair failed (exit ${r.status}): ${r.stderr}`);
  }
}

function basenameForId(state_dir: string): string {
  // state_dir is /tmp/.../ccr-e2e-real-<daemon_id>-XXX
  const m = state_dir.match(/ccr-e2e-real-([^-]+(?:-[^-]+)*)-[A-Za-z0-9]+$/);
  return m?.[1] ?? "daemon";
}
```

Wait — `pairDaemon` derives daemon_id from `state_dir` filename which is fragile. Simpler: take `daemon_id` as an explicit arg.

Replace `pairDaemon` with:

```typescript
export function pairDaemon(opts: { state_dir: string; hub_url: string; code: string; daemon_id: string }): void {
  const r = spawnSync("bun", [
    "run", join(ROOT, "packages/daemon/bin/cc-remote.ts"),
    "pair", "--hub", opts.hub_url, "--code", opts.code, "--daemon-id", opts.daemon_id,
  ], { env: { ...process.env, CC_REMOTE_STATE_DIR: opts.state_dir }, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`cc-remote pair failed (exit ${r.status}): ${r.stderr}`);
  }
}
```

Remove the `basenameForId` helper.

- [ ] **Step 2: Verify typecheck**

```bash
bun run --filter=@cc-remote/e2e-real typecheck
```

- [ ] **Step 3: Commit**

```bash
git add e2e-real/helpers/daemon.ts
git commit -m "feat(e2e-real): helpers/daemon"
```

---

## Task 7: helpers/claude.ts

**Files:**
- Create: `e2e-real/helpers/claude.ts`

- [ ] **Step 1: Create `e2e-real/helpers/claude.ts`**

```typescript
import { spawn, type ChildProcess, spawnSync } from "node:child_process";

export interface ClaudeOpts {
  cwd: string;
  prompt: string;
  channel_plugin?: string;
  api_key?: string;
  socket_path?: string;
  model?: string;
  envExtra?: Record<string, string>;
}

export interface ClaudeHandle {
  proc: ChildProcess;
  stderr(): string;
  stdout(): string;
  exited(): boolean;
  exitCode(): number | null;
  stop(): void;
  waitExit(timeoutMs: number): Promise<number>;
}

export function startClaude(opts: ClaudeOpts): ClaudeHandle {
  const apiKey = opts.api_key ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required for real e2e (export it in your shell)");
  const which = spawnSync("which", ["claude"], { encoding: "utf8" });
  if (which.status !== 0) throw new Error("`claude` not on PATH; install Claude Code first");

  const args = [
    "--channels", opts.channel_plugin ?? "plugin:cc-remote@local",
    "-p", opts.prompt,
  ];
  if (opts.model ?? process.env.CCR_E2E_MODEL) {
    args.push("--model", opts.model ?? process.env.CCR_E2E_MODEL!);
  }

  const proc = spawn("claude", args, {
    cwd: opts.cwd,
    env: {
      ...process.env,
      ...opts.envExtra,
      ANTHROPIC_API_KEY: apiKey,
      ...(opts.socket_path ? { CC_REMOTE_SOCKET: opts.socket_path } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderrBuf = "";
  let stdoutBuf = "";
  let exited = false;
  let exitCodeVal: number | null = null;
  proc.stderr?.on("data", (b: Buffer) => { stderrBuf += b.toString(); });
  proc.stdout?.on("data", (b: Buffer) => { stdoutBuf += b.toString(); });
  proc.on("exit", (c) => { exited = true; exitCodeVal = c; });

  return {
    proc,
    stderr: () => stderrBuf,
    stdout: () => stdoutBuf,
    exited: () => exited,
    exitCode: () => exitCodeVal,
    stop() { try { proc.kill("SIGTERM"); } catch {} },
    async waitExit(timeoutMs: number): Promise<number> {
      const start = Date.now();
      while (!exited) {
        if (Date.now() - start > timeoutMs) {
          throw new Error(`claude did not exit within ${timeoutMs}ms.\nstderr:\n${stderrBuf}`);
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      return exitCodeVal ?? 0;
    },
  };
}
```

- [ ] **Step 2: Verify typecheck**

```bash
bun run --filter=@cc-remote/e2e-real typecheck
```

- [ ] **Step 3: Commit**

```bash
git add e2e-real/helpers/claude.ts
git commit -m "feat(e2e-real): helpers/claude"
```

---

## Task 8: helpers/pwa-client.ts

**Files:**
- Create: `e2e-real/helpers/pwa-client.ts`

- [ ] **Step 1: Create `e2e-real/helpers/pwa-client.ts`**

```typescript
import type { HubToPwa, PwaToHub, PwaPermissionRequest } from "@cc-remote/proto";

export interface PwaClientOpts {
  hub_http: string;       // http://localhost:7745
  hub_ws: string;         // ws://localhost:7745
}

export interface PwaClient {
  bearer: string;
  ws: WebSocket;
  inbox: HubToPwa[];
  send(frame: PwaToHub): void;
  waitFor<T extends HubToPwa = HubToPwa>(
    pred: (f: HubToPwa) => boolean | T,
    timeoutMs?: number,
    label?: string,
  ): Promise<T>;
  approve(req: PwaPermissionRequest): void;
  deny(req: PwaPermissionRequest): void;
  close(): void;
}

export async function loginAndConnect(opts: PwaClientOpts): Promise<PwaClient> {
  const r1 = await fetch(`${opts.hub_http}/auth/login`, { redirect: "manual" });
  if (r1.status !== 302) throw new Error(`/auth/login expected 302, got ${r1.status}`);
  const authorizeUrl = r1.headers.get("location");
  if (!authorizeUrl) throw new Error("/auth/login: missing Location");

  const r2 = await fetch(authorizeUrl, { redirect: "manual" });
  if (r2.status !== 302) throw new Error(`fake-IAS authorize expected 302, got ${r2.status}: ${await r2.text()}`);
  const callbackUrl = r2.headers.get("location");
  if (!callbackUrl) throw new Error("authorize: missing Location");

  const r3 = await fetch(callbackUrl, { redirect: "manual" });
  if (r3.status !== 302) throw new Error(`/auth/callback expected 302, got ${r3.status}: ${await r3.text()}`);
  const finalLoc = r3.headers.get("location") ?? "";
  const m = finalLoc.match(/#bearer=([^&]+)/);
  if (!m || !m[1]) throw new Error(`no #bearer in callback Location: ${finalLoc}`);
  const bearer = decodeURIComponent(m[1]);

  const ws = new WebSocket(`${opts.hub_ws}/ws/pwa?bearer=${encodeURIComponent(bearer)}`);
  const inbox: HubToPwa[] = [];
  const subscribers: Array<(f: HubToPwa) => void> = [];
  ws.addEventListener("message", (ev) => {
    try {
      const f = JSON.parse(typeof ev.data === "string" ? ev.data : "") as HubToPwa;
      inbox.push(f);
      for (const s of subscribers) s(f);
    } catch {}
  });
  await new Promise<void>((res, rej) => {
    ws.addEventListener("open", () => res(), { once: true });
    ws.addEventListener("error", () => rej(new Error("ws upgrade failed")), { once: true });
  });
  ws.send(JSON.stringify({ type: "subscribe" } satisfies PwaToHub));

  const send = (frame: PwaToHub) => ws.send(JSON.stringify(frame));

  const waitFor = async <T extends HubToPwa = HubToPwa>(
    pred: (f: HubToPwa) => boolean | T,
    timeoutMs = 10_000,
    label = "predicate",
  ): Promise<T> => {
    const matched = (f: HubToPwa): T | null => {
      const r = pred(f);
      if (r === true) return f as T;
      if (r === false) return null;
      return r;
    };
    for (const f of inbox) { const m = matched(f); if (m) return m; }
    return new Promise<T>((res, rej) => {
      const tid = setTimeout(() => {
        const last = inbox.slice(-20).map((f) => f.type).join(", ");
        rej(new Error(`waitFor "${label}" timed out after ${timeoutMs}ms; last 20 frame types: [${last}]`));
      }, timeoutMs);
      subscribers.push((f) => {
        const m = matched(f);
        if (m) { clearTimeout(tid); res(m); }
      });
    });
  };

  return {
    bearer, ws, inbox, send, waitFor,
    approve(req) {
      send({
        type: "permission_reply",
        daemon_id: req.daemon_id, session_id: req.session_id,
        request_id: req.request_id, decision: "allow",
      });
    },
    deny(req) {
      send({
        type: "permission_reply",
        daemon_id: req.daemon_id, session_id: req.session_id,
        request_id: req.request_id, decision: "deny",
      });
    },
    close() { try { ws.close(); } catch {} },
  };
}
```

- [ ] **Step 2: Verify typecheck**

```bash
bun run --filter=@cc-remote/e2e-real typecheck
```

- [ ] **Step 3: Commit**

```bash
git add e2e-real/helpers/pwa-client.ts
git commit -m "feat(e2e-real): helpers/pwa-client"
```

---

## Task 9: helpers/preflight.ts

**Files:**
- Create: `e2e-real/helpers/preflight.ts`

- [ ] **Step 1: Create `e2e-real/helpers/preflight.ts`**

```typescript
import { spawnSync } from "node:child_process";

export interface PreflightResult {
  ok: boolean;
  errors: string[];
}

export function preflight(): PreflightResult {
  const errors: string[] = [];

  const dockerInfo = spawnSync("docker", ["info"], { encoding: "utf8" });
  if (dockerInfo.status !== 0) {
    errors.push("docker daemon not running (`docker info` failed). Start Docker Desktop or your daemon.");
  }

  const which = spawnSync("which", ["claude"], { encoding: "utf8" });
  if (which.status !== 0) {
    errors.push("`claude` not on PATH. Install Claude Code: https://docs.anthropic.com/en/docs/claude-code");
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    errors.push("ANTHROPIC_API_KEY not set. Export it in your shell before running e2e-real.");
  }

  // Best-effort: warn (don't fail) if cc-remote install hasn't run.
  // We can't be 100% sure without parsing Claude Code's plugin marketplace state,
  // so this is advisory.
  return { ok: errors.length === 0, errors };
}

export function preflightOrThrow(): void {
  const r = preflight();
  if (!r.ok) {
    throw new Error("Preflight failed:\n  - " + r.errors.join("\n  - "));
  }
}
```

- [ ] **Step 2: Verify typecheck**

```bash
bun run --filter=@cc-remote/e2e-real typecheck
```

- [ ] **Step 3: Commit**

```bash
git add e2e-real/helpers/preflight.ts
git commit -m "feat(e2e-real): helpers/preflight"
```

---

## Task 10: Scenario 01 — pair and snapshot (the smoke test that validates infrastructure)

**Files:**
- Create: `e2e-real/tests/01-pair-and-snapshot.test.ts`

This is the first "real" scenario; it validates everything: docker, IAS flow, pair, daemon, real Claude session, hub→PWA snapshot.

- [ ] **Step 1: Create `e2e-real/tests/01-pair-and-snapshot.test.ts`**

```typescript
import { test, expect, beforeAll, afterAll } from "bun:test";
import { upCompose, downCompose } from "../helpers/compose.ts";
import { preflightOrThrow } from "../helpers/preflight.ts";
import { issuePairingCode } from "../helpers/admin.ts";
import { startDaemon, pairDaemon } from "../helpers/daemon.ts";
import { startClaude } from "../helpers/claude.ts";
import { loginAndConnect } from "../helpers/pwa-client.ts";

beforeAll(async () => {
  preflightOrThrow();
  await upCompose();
}, 120_000);
afterAll(async () => { await downCompose(); }, 60_000);

test("real Claude session pairs and shows up in PWA snapshot", async () => {
  const daemon_id = `pair-snap-${Date.now()}`;
  const code = issuePairingCode(daemon_id);

  const daemon = await startDaemon({ daemon_id, hub_url: "ws://localhost:7745" });
  pairDaemon({ state_dir: daemon.state_dir, hub_url: "http://localhost:7745", code, daemon_id });

  // Daemon needs to reconnect with new JWT after pair. Restart to be safe.
  await daemon.stop();
  const daemon2 = await startDaemon({ daemon_id, hub_url: "ws://localhost:7745" });

  const pwa = await loginAndConnect({
    hub_http: "http://localhost:7745",
    hub_ws: "ws://localhost:7745",
  });

  const claude = startClaude({ cwd: "/tmp", prompt: "echo hi" });
  try {
    const opened = await pwa.waitFor((f) => {
      if (f.type === "session_open" && f.daemon_id === daemon_id) return f;
      if (f.type === "snapshot") {
        for (const d of f.daemons) {
          if (d.daemon_id === daemon_id && d.sessions.length > 0) return f;
        }
      }
      return false;
    }, 30_000, "session_open or snapshot containing daemon's session");
    expect(opened).toBeTruthy();
  } finally {
    pwa.close();
    claude.stop();
    await daemon2.stop();
  }
}, 60_000);
```

The "restart daemon after pair" pattern reflects real-world setup: pair writes state.json, daemon needs to load it. We start unauthenticated, pair, restart authenticated.

- [ ] **Step 2: Run the scenario**

```bash
bun test e2e-real/tests/01-pair-and-snapshot.test.ts
```

Expected: 1 PASS in ~30–60s (compose build the first time may add 1–2 min). On subsequent runs the build cache makes it fast.

- [ ] **Step 3: Commit**

```bash
git add e2e-real/tests/01-pair-and-snapshot.test.ts
git commit -m "test(e2e-real): 01 pair + real Claude snapshot"
```

---

## Task 11: Scenario 07 — multi-daemon (uses fake-claude, no real Claude)

**Files:**
- Create: `e2e-real/tests/07-multi-daemon.test.ts`

Multi-daemon explicitly uses fake-claude (per spec §5 boundary): we are testing hub routing, not LLM behavior.

- [ ] **Step 1: Create `e2e-real/tests/07-multi-daemon.test.ts`**

```typescript
import { test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { join, resolve } from "node:path";
import { upCompose, downCompose } from "../helpers/compose.ts";
import { preflightOrThrow } from "../helpers/preflight.ts";
import { issuePairingCode } from "../helpers/admin.ts";
import { startDaemon, pairDaemon } from "../helpers/daemon.ts";
import { loginAndConnect } from "../helpers/pwa-client.ts";

const ROOT = resolve(import.meta.dir, "..", "..");

beforeAll(async () => { preflightOrThrow(); await upCompose(); }, 120_000);
afterAll(async () => { await downCompose(); }, 60_000);

test("3 concurrent paired daemons all surface", async () => {
  const ids = ["md-a", "md-b", "md-c"].map((p) => `${p}-${Date.now()}`);
  const daemons: Awaited<ReturnType<typeof startDaemon>>[] = [];
  const fakes: ChildProcess[] = [];
  try {
    for (const daemon_id of ids) {
      const code = issuePairingCode(daemon_id);
      const d = await startDaemon({ daemon_id, hub_url: "ws://localhost:7745" });
      pairDaemon({ state_dir: d.state_dir, hub_url: "http://localhost:7745", code, daemon_id });
      await d.stop();
      const d2 = await startDaemon({ daemon_id, hub_url: "ws://localhost:7745" });
      daemons.push(d2);
      const fc = spawn("bun", [
        join(ROOT, "tools/fake-claude/fake-claude.ts"),
        "--session-id", `s-${daemon_id}`, "--cwd", `/tmp/${daemon_id}`,
        "--socket", join(d2.state_dir, "daemon.sock"),
      ], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
      fakes.push(fc);
    }

    const pwa = await loginAndConnect({
      hub_http: "http://localhost:7745",
      hub_ws: "ws://localhost:7745",
    });
    try {
      // For each id, wait until a session for it surfaces.
      for (const id of ids) {
        await pwa.waitFor((f) => {
          if (f.type === "snapshot") {
            for (const d of f.daemons) {
              if (d.daemon_id === id && d.sessions.some((s) => s.session_id === `s-${id}`)) return f;
            }
          }
          if (f.type === "session_open" && f.daemon_id === id && f.session.session_id === `s-${id}`) return f;
          return false;
        }, 15_000, `session for ${id}`);
      }
      expect(true).toBe(true);
    } finally {
      pwa.close();
    }
  } finally {
    for (const fc of fakes) try { fc.kill("SIGTERM"); } catch {}
    for (const d of daemons) await d.stop();
  }
}, 90_000);
```

- [ ] **Step 2: Run**

```bash
bun test e2e-real/tests/07-multi-daemon.test.ts
```

Expected: 1 PASS.

- [ ] **Step 3: Commit**

```bash
git add e2e-real/tests/07-multi-daemon.test.ts
git commit -m "test(e2e-real): 07 multi-daemon"
```

---

## Task 12: Scenario 11 — daemon-offline push (file-log stub)

**Files:**
- Create: `e2e-real/tests/11-offline-push.test.ts`

Uses `OFFLINE_PUSH_DELAY_MS=200` for a short test. Verifies the file-log push stub records a `kind: "offline"` entry when daemon disconnects.

- [ ] **Step 1: Modify hub config to read OFFLINE_PUSH_DELAY_MS**

Read `packages/hub/src/index.ts`. The Router takes options including `offline_push_delay_ms`. The hub entry currently doesn't pass it. Add:

```typescript
const offlinePushDelayMs = process.env.HUB_OFFLINE_PUSH_DELAY_MS
  ? Number(process.env.HUB_OFFLINE_PUSH_DELAY_MS)
  : undefined;
```

And modify the `makeServer` call to thread it through. But `makeServer` constructs Router internally — read its signature. If `MakeServerOpts` doesn't already have an `offline_push_delay_ms`, add one and forward to `new Router(...)` constructor. Read the current state of `routes.ts` and `index.ts` to confirm.

This may require touching `packages/hub/src/routes.ts`. Cleanest path:

1. Add `offline_push_delay_ms?: number` to `MakeServerOpts`
2. Modify the `new Router(daemonReg, pwaReg, opts.db, opts.push)` call to also pass `{ offline_push_delay_ms: opts.offline_push_delay_ms }`
3. In `index.ts`, read env and pass to `makeServer`

```typescript
// In index.ts after loadConfig:
const offline_push_delay_ms = process.env.HUB_OFFLINE_PUSH_DELAY_MS
  ? Number(process.env.HUB_OFFLINE_PUSH_DELAY_MS) : undefined;
// In makeServer call, add:
makeServer({
  db, ias, jwt_secret: cfg.jwt_secret, disable_auth: cfg.disable_auth,
  pwa_url: cfg.pwa_url, push, offline_push_delay_ms,
});
```

In `routes.ts` modify both the interface and the `new Router(...)` call:
```typescript
export interface MakeServerOpts {
  // ... existing fields ...
  offline_push_delay_ms?: number;
}
// in makeServer body:
const router = new Router(daemonReg, pwaReg, opts.db, opts.push, {
  offline_push_delay_ms: opts.offline_push_delay_ms,
});
```

Verify Router constructor signature already accepts the option (it does, per Plan 11).

- [ ] **Step 2: Run hub tests to make sure existing ones pass**

```bash
bun test packages/hub
```

Expected: all hub tests pass.

- [ ] **Step 3: Add HUB_OFFLINE_PUSH_DELAY_MS to docker-compose.yml**

In `e2e-real/docker-compose.yml`, hub service `environment:` block, add:
```yaml
      HUB_OFFLINE_PUSH_DELAY_MS: "300"
```

(300ms — long enough that we can pair, opt in offline pref, and disconnect; short enough for a fast test.)

- [ ] **Step 4: Create `e2e-real/tests/11-offline-push.test.ts`**

```typescript
import { test, expect, beforeAll, afterAll } from "bun:test";
import { upCompose, downCompose, execHubCmd } from "../helpers/compose.ts";
import { preflightOrThrow } from "../helpers/preflight.ts";
import { issuePairingCode } from "../helpers/admin.ts";
import { startDaemon, pairDaemon } from "../helpers/daemon.ts";
import { loginAndConnect } from "../helpers/pwa-client.ts";

beforeAll(async () => { preflightOrThrow(); await upCompose(); }, 120_000);
afterAll(async () => { await downCompose(); }, 60_000);

test("daemon-offline push appears in trace log", async () => {
  const daemon_id = `offline-${Date.now()}`;
  const code = issuePairingCode(daemon_id);

  const d = await startDaemon({ daemon_id, hub_url: "ws://localhost:7745" });
  pairDaemon({ state_dir: d.state_dir, hub_url: "http://localhost:7745", code, daemon_id });
  await d.stop();
  const daemon = await startDaemon({ daemon_id, hub_url: "ws://localhost:7745" });

  const pwa = await loginAndConnect({
    hub_http: "http://localhost:7745",
    hub_ws: "ws://localhost:7745",
  });

  // Subscribe to push (simulated — fileLogHelper logs on every sendTo)
  // First, register a fake push subscription for our device, opt in to offline.
  const subRes = await fetch("http://localhost:7745/push/subscribe", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${pwa.bearer}`,
    },
    body: JSON.stringify({
      endpoint: "https://fake/x",
      keys: { p256dh: "p", auth: "a" },
    }),
  });
  expect(subRes.status).toBe(204);

  const prefRes = await fetch("http://localhost:7745/push/preferences", {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${pwa.bearer}`,
    },
    body: JSON.stringify({ offline: true }),
  });
  expect(prefRes.status).toBe(204);

  // Wait for daemon to be visible in snapshot.
  await pwa.waitFor((f) => f.type === "daemon_online" && f.daemon_id === daemon_id, 5000, "daemon_online");

  // Disconnect daemon.
  await daemon.stop();

  // Wait for offline push to be logged (HUB_OFFLINE_PUSH_DELAY_MS=300 in compose).
  // Poll the trace log up to 5s.
  const start = Date.now();
  let foundOffline = false;
  while (Date.now() - start < 5000 && !foundOffline) {
    try {
      const trace = execHubCmd(["sh", "-c", "cat /data/push-trace.log 2>/dev/null || true"]);
      const lines = trace.trim().split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as { payload?: { kind?: string; daemon_id?: string } };
          if (entry.payload?.kind === "offline" && entry.payload?.daemon_id === daemon_id) {
            foundOffline = true;
            break;
          }
        } catch {}
      }
    } catch {}
    if (!foundOffline) await new Promise((r) => setTimeout(r, 100));
  }
  pwa.close();
  expect(foundOffline).toBe(true);
}, 60_000);
```

- [ ] **Step 5: Rebuild hub image** (we modified hub source)

```bash
cd e2e-real
docker compose build hub
```

- [ ] **Step 6: Run the scenario**

```bash
cd ..
bun test e2e-real/tests/11-offline-push.test.ts
```

Expected: 1 PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/hub/src/index.ts packages/hub/src/routes.ts e2e-real/docker-compose.yml e2e-real/tests/11-offline-push.test.ts
git commit -m "test(e2e-real): 11 offline-push trace; HUB_OFFLINE_PUSH_DELAY_MS env"
```

---

## Task 13: Scenario 05 — task_completed (real Claude turn)

**Files:**
- Create: `e2e-real/tests/05-task-completed.test.ts`

- [ ] **Step 1: Create `e2e-real/tests/05-task-completed.test.ts`**

```typescript
import { test, expect, beforeAll, afterAll } from "bun:test";
import { upCompose, downCompose } from "../helpers/compose.ts";
import { preflightOrThrow } from "../helpers/preflight.ts";
import { issuePairingCode } from "../helpers/admin.ts";
import { startDaemon, pairDaemon } from "../helpers/daemon.ts";
import { startClaude } from "../helpers/claude.ts";
import { loginAndConnect } from "../helpers/pwa-client.ts";

beforeAll(async () => { preflightOrThrow(); await upCompose(); }, 120_000);
afterAll(async () => { await downCompose(); }, 60_000);

test("real Claude end_turn surfaces as task_completed", async () => {
  const daemon_id = `task-${Date.now()}`;
  const code = issuePairingCode(daemon_id);
  const d = await startDaemon({ daemon_id, hub_url: "ws://localhost:7745" });
  pairDaemon({ state_dir: d.state_dir, hub_url: "http://localhost:7745", code, daemon_id });
  await d.stop();
  const daemon = await startDaemon({ daemon_id, hub_url: "ws://localhost:7745" });

  const pwa = await loginAndConnect({
    hub_http: "http://localhost:7745",
    hub_ws: "ws://localhost:7745",
  });

  const claude = startClaude({ cwd: "/tmp", prompt: "echo done" });

  try {
    const completed = await pwa.waitFor((f) => {
      if (f.type === "task_completed" && f.daemon_id === daemon_id) return f;
      return false;
    }, 60_000, "task_completed");
    expect(completed).toBeTruthy();
    expect((completed as any).session_id).toBeTruthy();
  } finally {
    pwa.close();
    claude.stop();
    await daemon.stop();
  }
}, 90_000);
```

- [ ] **Step 2: Run**

```bash
bun test e2e-real/tests/05-task-completed.test.ts
```

Expected: 1 PASS in ~10–30s (Haiku is fast).

- [ ] **Step 3: Commit**

```bash
git add e2e-real/tests/05-task-completed.test.ts
git commit -m "test(e2e-real): 05 task_completed (real Claude)"
```

---

## Task 14: Scenario 06 — idle (real Claude turn + short window)

**Files:**
- Create: `e2e-real/tests/06-idle.test.ts`

- [ ] **Step 1: Create `e2e-real/tests/06-idle.test.ts`**

```typescript
import { test, expect, beforeAll, afterAll } from "bun:test";
import { upCompose, downCompose } from "../helpers/compose.ts";
import { preflightOrThrow } from "../helpers/preflight.ts";
import { issuePairingCode } from "../helpers/admin.ts";
import { startDaemon, pairDaemon } from "../helpers/daemon.ts";
import { startClaude } from "../helpers/claude.ts";
import { loginAndConnect } from "../helpers/pwa-client.ts";

beforeAll(async () => { preflightOrThrow(); await upCompose(); }, 120_000);
afterAll(async () => { await downCompose(); }, 60_000);

test("idle event fires after task_completed within idle_window_ms", async () => {
  const daemon_id = `idle-${Date.now()}`;
  const code = issuePairingCode(daemon_id);
  const d = await startDaemon({ daemon_id, hub_url: "ws://localhost:7745", idle_window_ms: 500 });
  pairDaemon({ state_dir: d.state_dir, hub_url: "http://localhost:7745", code, daemon_id });
  await d.stop();
  const daemon = await startDaemon({ daemon_id, hub_url: "ws://localhost:7745", idle_window_ms: 500 });

  const pwa = await loginAndConnect({
    hub_http: "http://localhost:7745",
    hub_ws: "ws://localhost:7745",
  });

  const claude = startClaude({ cwd: "/tmp", prompt: "echo idle test" });

  try {
    await pwa.waitFor((f) => f.type === "task_completed" && f.daemon_id === daemon_id, 60_000, "task_completed");
    const idle = await pwa.waitFor((f) => f.type === "idle" && f.daemon_id === daemon_id, 5_000, "idle");
    expect(idle).toBeTruthy();
  } finally {
    pwa.close();
    claude.stop();
    await daemon.stop();
  }
}, 90_000);
```

- [ ] **Step 2: Run**

```bash
bun test e2e-real/tests/06-idle.test.ts
```

Expected: 1 PASS.

- [ ] **Step 3: Commit**

```bash
git add e2e-real/tests/06-idle.test.ts
git commit -m "test(e2e-real): 06 idle (real Claude)"
```

---

## Task 15: Scenario 04 — history scroll-back (real Claude)

**Files:**
- Create: `e2e-real/tests/04-history-scrollback.test.ts`

- [ ] **Step 1: Create `e2e-real/tests/04-history-scrollback.test.ts`**

```typescript
import { test, expect, beforeAll, afterAll } from "bun:test";
import { upCompose, downCompose } from "../helpers/compose.ts";
import { preflightOrThrow } from "../helpers/preflight.ts";
import { issuePairingCode } from "../helpers/admin.ts";
import { startDaemon, pairDaemon } from "../helpers/daemon.ts";
import { startClaude } from "../helpers/claude.ts";
import { loginAndConnect } from "../helpers/pwa-client.ts";

beforeAll(async () => { preflightOrThrow(); await upCompose(); }, 120_000);
afterAll(async () => { await downCompose(); }, 60_000);

test("PWA can request_history after a real Claude turn", async () => {
  const daemon_id = `hist-${Date.now()}`;
  const code = issuePairingCode(daemon_id);
  const d = await startDaemon({ daemon_id, hub_url: "ws://localhost:7745" });
  pairDaemon({ state_dir: d.state_dir, hub_url: "http://localhost:7745", code, daemon_id });
  await d.stop();
  const daemon = await startDaemon({ daemon_id, hub_url: "ws://localhost:7745" });

  const pwa = await loginAndConnect({
    hub_http: "http://localhost:7745",
    hub_ws: "ws://localhost:7745",
  });

  const claude = startClaude({ cwd: "/tmp", prompt: "echo line1, then echo line2, then echo line3" });

  try {
    // Wait for the session to come up + at least one event.
    const sessionOpen = await pwa.waitFor((f) => {
      if (f.type === "session_open" && f.daemon_id === daemon_id) return f;
      return false;
    }, 30_000, "session_open");
    const session_id = (sessionOpen as any).session.session_id as string;

    // Wait for the turn to complete so the JSONL has multiple lines.
    await pwa.waitFor((f) => f.type === "task_completed" && f.daemon_id === daemon_id, 60_000, "task_completed");

    // Now request history.
    pwa.send({
      type: "request_history",
      daemon_id,
      session_id,
      request_id: "rh-test",
      before_offset: Number.MAX_SAFE_INTEGER,
      limit: 100,
    });

    const chunk = await pwa.waitFor((f) => {
      if (f.type === "history_chunk" && f.daemon_id === daemon_id && f.request_id === "rh-test") return f;
      return false;
    }, 10_000, "history_chunk");
    expect((chunk as any).events.length).toBeGreaterThan(0);
  } finally {
    pwa.close();
    claude.stop();
    await daemon.stop();
  }
}, 120_000);
```

- [ ] **Step 2: Run**

```bash
bun test e2e-real/tests/04-history-scrollback.test.ts
```

Expected: 1 PASS.

- [ ] **Step 3: Commit**

```bash
git add e2e-real/tests/04-history-scrollback.test.ts
git commit -m "test(e2e-real): 04 history scroll-back"
```

---

## Task 16: Scenarios 02, 03, 10 — permission scenarios (BLOCKED until Task 0 is done)

**Files:**
- Create: `e2e-real/tests/02-permission-relay.test.ts`
- Create: `e2e-real/tests/03-permission-deny.test.ts`
- Create: `e2e-real/tests/10-perm-p95.test.ts`

These three scenarios depend on Task 0's findings. There are two paths:

**Path A — full real channel-permission protocol works:**

The plugin already participates correctly. Scenario 02 prompts Claude to read a sandbox file, expects a real `permission_request` from Claude → forwarded by daemon → received by PWA, PWA approves, Claude continues. Scenario 03 denies. Scenario 10 runs 20 sequential reads.

**Path B — protocol incomplete or the plugin needs more work:**

Scenarios 02/03 use `CC_REMOTE_FAKE_PERMISSION` env on the plugin. We test the relay path (plugin → daemon → hub → PWA → daemon → plugin) with a synthesized permission, accept that we're not testing Claude Code's actual permission emission. Document this gap explicitly in test comments.

Given the implementation can take either path, the agent that does this task **first reads `docs/superpowers/research/channel-permission-protocol.md`** (T0 output), then chooses Path A or Path B based on findings.

- [ ] **Step 1: Read `docs/superpowers/research/channel-permission-protocol.md`** to determine which path

- [ ] **Step 2: Implement scenarios 02, 03, 10** under the chosen path

For Path A scenario 02:
```typescript
const claude = startClaude({
  cwd: "/tmp",
  prompt: `Read /tmp/ccr-sandbox.txt and tell me its first line.`,
});

const req = await pwa.waitFor(
  (f) => f.type === "permission_request" && f.daemon_id === daemon_id ? f : false,
  30_000, "permission_request",
);
pwa.approve(req as any);
const resolved = await pwa.waitFor(
  (f) => f.type === "permission_resolved" && (f as any).request_id === (req as any).request_id ? f : false,
  10_000, "permission_resolved",
);
expect((resolved as any).decision).toBe("allow");
```

For Path B scenario 02 (using the fake permission env):
```typescript
const claude = startClaude({
  cwd: "/tmp", prompt: "echo hi",
  envExtra: {
    CC_REMOTE_FAKE_PERMISSION: "Read",
    CC_REMOTE_FAKE_REQUEST_ID: "perm-real-1",
    CC_REMOTE_FAKE_ARGS: "/tmp/ccr-sandbox.txt",
  },
});
// rest is the same
```

The full test code for both paths is mechanical extension of Task 13's structure plus the permission frame round-trip. The agent picks the path and writes the analogous file.

- [ ] **Step 3: Run all three scenarios**

```bash
bun test e2e-real/tests/02-permission-relay.test.ts
bun test e2e-real/tests/03-permission-deny.test.ts
bun test e2e-real/tests/10-perm-p95.test.ts
```

Expected: 3 PASS.

- [ ] **Step 4: Commit**

```bash
git add e2e-real/tests/02-permission-relay.test.ts e2e-real/tests/03-permission-deny.test.ts e2e-real/tests/10-perm-p95.test.ts
git commit -m "test(e2e-real): 02 + 03 + 10 permission scenarios (path: <A or B per T0>)"
```

---

## Task 17: Scenario 08 — kill_session (real Claude)

**Files:**
- Create: `e2e-real/tests/08-kill-session.test.ts`

- [ ] **Step 1: Create `e2e-real/tests/08-kill-session.test.ts`**

```typescript
import { test, expect, beforeAll, afterAll } from "bun:test";
import { upCompose, downCompose } from "../helpers/compose.ts";
import { preflightOrThrow } from "../helpers/preflight.ts";
import { issuePairingCode } from "../helpers/admin.ts";
import { startDaemon, pairDaemon } from "../helpers/daemon.ts";
import { startClaude } from "../helpers/claude.ts";
import { loginAndConnect } from "../helpers/pwa-client.ts";

beforeAll(async () => { preflightOrThrow(); await upCompose(); }, 120_000);
afterAll(async () => { await downCompose(); }, 60_000);

test("PWA kill_session terminates a real Claude session", async () => {
  const daemon_id = `kill-${Date.now()}`;
  const code = issuePairingCode(daemon_id);
  const d = await startDaemon({ daemon_id, hub_url: "ws://localhost:7745", allow_kill: true });
  pairDaemon({ state_dir: d.state_dir, hub_url: "http://localhost:7745", code, daemon_id });
  await d.stop();
  const daemon = await startDaemon({ daemon_id, hub_url: "ws://localhost:7745", allow_kill: true });

  const pwa = await loginAndConnect({
    hub_http: "http://localhost:7745",
    hub_ws: "ws://localhost:7745",
  });

  const claude = startClaude({
    cwd: "/tmp",
    prompt: "count from 1 to 100 slowly, one number per line",
  });

  try {
    const opened = await pwa.waitFor((f) => {
      if (f.type === "session_open" && f.daemon_id === daemon_id) return f;
      return false;
    }, 30_000, "session_open");
    const session_id = (opened as any).session.session_id as string;

    pwa.send({ type: "kill_session", daemon_id, session_id });

    const closed = await pwa.waitFor((f) => {
      if (f.type === "session_close" && f.daemon_id === daemon_id && (f as any).session_id === session_id) return f;
      return false;
    }, 10_000, "session_close");
    expect(closed).toBeTruthy();

    // Claude should have exited.
    await claude.waitExit(10_000);
    expect(claude.exited()).toBe(true);
  } finally {
    pwa.close();
    if (!claude.exited()) claude.stop();
    await daemon.stop();
  }
}, 120_000);
```

- [ ] **Step 2: Run**

```bash
bun test e2e-real/tests/08-kill-session.test.ts
```

Expected: 1 PASS.

- [ ] **Step 3: Commit**

```bash
git add e2e-real/tests/08-kill-session.test.ts
git commit -m "test(e2e-real): 08 kill_session (real Claude)"
```

---

## Task 18: Scenario 09 — start_session (real Claude spawn)

**Files:**
- Create: `e2e-real/tests/09-start-session.test.ts`

- [ ] **Step 1: Create `e2e-real/tests/09-start-session.test.ts`**

```typescript
import { test, expect, beforeAll, afterAll } from "bun:test";
import { upCompose, downCompose } from "../helpers/compose.ts";
import { preflightOrThrow } from "../helpers/preflight.ts";
import { issuePairingCode } from "../helpers/admin.ts";
import { startDaemon, pairDaemon } from "../helpers/daemon.ts";
import { loginAndConnect } from "../helpers/pwa-client.ts";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";

beforeAll(async () => { preflightOrThrow(); await upCompose(); }, 120_000);
afterAll(async () => { await downCompose(); }, 60_000);

test("PWA start_session launches a real claude in tmux", async () => {
  // tmux must be installed for start_session.
  const which = spawnSync("which", ["tmux"], { encoding: "utf8" });
  if (which.status !== 0) {
    console.warn("tmux not on PATH; skipping start_session scenario");
    return;
  }

  const daemon_id = `start-${Date.now()}`;
  const cwd = `/tmp/ccr-start-${Date.now()}`;
  mkdirSync(cwd, { recursive: true });
  try {
    const code = issuePairingCode(daemon_id);
    const tmuxName = `ccr-start-${Date.now()}`;
    const d = await startDaemon({
      daemon_id, hub_url: "ws://localhost:7745",
      allow_start: true,
      allowed_cwd_prefix: [cwd],
      spawn_command: `claude --channels plugin:cc-remote@local -p "echo started"`,
    });
    pairDaemon({ state_dir: d.state_dir, hub_url: "http://localhost:7745", code, daemon_id });
    await d.stop();
    const daemon = await startDaemon({
      daemon_id, hub_url: "ws://localhost:7745",
      allow_start: true,
      allowed_cwd_prefix: [cwd],
      spawn_command: `claude --channels plugin:cc-remote@local -p "echo started"`,
    });

    const pwa = await loginAndConnect({
      hub_http: "http://localhost:7745",
      hub_ws: "ws://localhost:7745",
    });
    try {
      pwa.send({ type: "start_session", daemon_id, cwd, name: tmuxName });

      // The spawned claude registers a session via the plugin, surfaces in PWA.
      await pwa.waitFor((f) => {
        if (f.type === "session_open" && f.daemon_id === daemon_id) return f;
        return false;
      }, 60_000, "session_open from spawned claude");
    } finally {
      pwa.close();
      // Defensive: kill any tmux session left behind.
      try { spawnSync("tmux", ["kill-session", "-t", tmuxName], { stdio: "ignore" }); } catch {}
      await daemon.stop();
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 120_000);
```

- [ ] **Step 2: Run**

```bash
bun test e2e-real/tests/09-start-session.test.ts
```

Expected: 1 PASS (skips if no tmux).

- [ ] **Step 3: Commit**

```bash
git add e2e-real/tests/09-start-session.test.ts
git commit -m "test(e2e-real): 09 start_session (real claude spawn)"
```

---

## Task 19: Final verification — full e2e-real suite

- [ ] **Step 1: Ensure all hub tests still pass**

```bash
bun test packages/
```

Expected: 164+ existing tests pass (we added the file-log push test).

- [ ] **Step 2: Run the entire e2e-real suite**

```bash
bun test e2e-real/
```

Expected: 11 scenario files, each passing. Should complete in < 5 minutes total (per spec §8 acceptance).

- [ ] **Step 3: Verify typecheck across all packages**

```bash
bun run typecheck
```

Expected: 5 existing packages + 1 new (e2e-real) all clean.

- [ ] **Step 4: Update README at repo root with a short pointer**

Read the root `README.md`. Add a short section after "Tests":

```markdown
## Real-component e2e (`e2e-real/`)

Separate suite that runs hub + fake-IAS in docker, daemon and Claude Code natively, scripted PWA-equivalent. Pre-release acceptance gate. See [`e2e-real/README.md`](e2e-real/README.md) and [the spec](docs/superpowers/specs/2026-05-19-real-e2e-design.md).
```

- [ ] **Step 5: Commit + tag**

```bash
git add README.md
git commit -m "docs: link real-e2e suite from root README"
git tag plan-real-e2e
```

---

## Self-Review

**Spec coverage** (against `docs/superpowers/specs/2026-05-19-real-e2e-design.md`):

| Spec section | Plan task |
| --- | --- |
| §3 Architecture overview | Tasks 1, 2, 3 establish topology |
| §4.1 docker-compose.yml | Task 2 |
| §4.2 helpers/compose.ts | Task 3 |
| §4.3 helpers/daemon.ts | Task 6 |
| §4.4 helpers/claude.ts | Task 7 |
| §4.5 helpers/pwa-client.ts | Task 8 |
| §4.6 helpers/admin.ts | Task 5 |
| §4.7 Scenarios | Tasks 10–18 |
| §5 11 acceptance scenarios | Tasks 10 (01) + 11 (07) + 12 (11) + 13 (05) + 14 (06) + 15 (04) + 16 (02/03/10) + 17 (08) + 18 (09). 11 scenarios, 9 tasks (one task covers 3 permission scenarios). All accounted for. |
| §6 file-log push stub | Task 4 (production code) + Task 12 (consumes it) |
| §7 Error handling and diagnostics | Distributed across helper tasks (3, 6, 7, 8) — each helper bundles diagnostics on failure |
| §8 Suite acceptance criteria | Task 19 |
| §9 Open implementation questions | Task 0 addresses #1 (channel-permission protocol). Other open questions are documented but don't block any task |

**Placeholder scan:** searched for "TBD" / "TODO" / "implement later" — none in this plan body. Task 16 ("Path A or B") explicitly defers a decision based on Task 0 findings, but each path's implementation is sketched concretely in the task body.

**Type consistency:**
- `DaemonOpts` shape (Task 6) matches what scenarios pass (Tasks 10, 12, 13, 14, 15, 17, 18)
- `ClaudeOpts` (Task 7) matches what scenarios pass
- `PwaClient.waitFor` signature in Task 8 matches usage in all scenario tasks
- `issuePairingCode(daemon_id)` (Task 5) matches the call in scenarios

**Granularity:** 19 tasks. Each task is self-contained: one file or a tight cluster of related files, with a clear test gate (compose builds, scenario passes, or typecheck passes). Tasks 10–18 each produce one independently-runnable scenario file.

**Self-review pass complete.** No issues found.
