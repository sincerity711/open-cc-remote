# open-cc-remote — Plan 1: Foundation + Vertical Slice

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the four components (plugin, daemon, hub, PWA) end-to-end with no auth, so a Claude Code session running with `--channels plugin:cc-remote@local` shows up as a row in the PWA in real time. Validates the architecture; nothing else.

**Architecture:** Bun-runtime TypeScript monorepo. Plugin is an MCP stdio server. Daemon is a long-lived Bun process exposing a Unix socket inward and a WSS client outward. Hub is a Bun HTTP/WSS server with no persistence yet. PWA is a Vite/React app talking WSS to the hub.

**Tech Stack:**
- Bun (runtime + workspaces + bundler + test runner)
- TypeScript 5.x (strict)
- `@modelcontextprotocol/sdk` for the plugin
- React 18 + Vite 5 for the PWA
- `bun:test` for backend tests, `vitest` for PWA
- Single-machine local hub (no TLS, no IAS) for this milestone

**Out of scope for Plan 1:** authentication, DPoP, IAS, JSONL streaming, permission relay, persistence (SQLite), Web Push, file uploads, install scripts.

---

## File Structure

```
.
├── package.json                 ← bun workspaces root
├── bunfig.toml                  ← bun test config
├── tsconfig.base.json           ← shared TS settings
├── packages/
│   ├── proto/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── frames.ts        ← all wire frame TS interfaces
│   │       ├── codec.ts         ← length-prefixed JSON encode/decode (Unix socket)
│   │       └── index.ts
│   │   └── tests/
│   │       └── codec.test.ts
│   ├── plugin/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts         ← MCP entry; reads env, connects daemon
│   │       └── daemon-client.ts ← Unix socket client
│   ├── daemon/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts         ← entry; loads config, starts services
│   │       ├── config.ts        ← load ~/.cc-remote/config.toml
│   │       ├── registry.ts      ← in-memory liveSessions map
│   │       ├── socket-server.ts ← Unix socket server for plugin
│   │       └── hub-client.ts    ← WSS client to hub w/ reconnect
│   │   └── tests/
│   │       ├── registry.test.ts
│   │       └── socket-server.test.ts
│   ├── hub/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts         ← entry: Bun.serve
│   │       ├── routes.ts        ← HTTP + WSS routing
│   │       ├── connections.ts   ← daemon + PWA connection registries
│   │       └── router.ts        ← frame fanout: daemon ↔ PWA
│   │   └── tests/
│   │       └── router.test.ts
│   └── pwa/
│       ├── package.json
│       ├── tsconfig.json
│       ├── vite.config.ts
│       ├── index.html
│       └── src/
│           ├── main.tsx
│           ├── App.tsx          ← session list view
│           └── ws.ts            ← WSS client hook
├── tools/
│   └── fake-claude/
│       └── fake-claude.ts       ← test harness: spawns plugin and idles
├── e2e/
│   └── snapshot.test.ts         ← full-loop e2e
└── docs/
    └── superpowers/
        ├── specs/2026-05-18-open-cc-remote-design.md
        └── plans/2026-05-18-open-cc-remote-plan-01-foundation.md  (this file)
```

Why this split:
- `proto` is the only thing all four components share. Making it a workspace package (rather than sym-linked types) gets us proper TS isolation and test surface for codec edge cases.
- `daemon` is the most complex and has multiple responsibilities (Unix socket, hub client, registry); splitting by module-per-file keeps each focused.
- `tools/fake-claude` lives outside `packages/` because it's a test-only harness, not a published artifact.

---

## Task 1: Bun monorepo skeleton

**Files:**
- Create: `package.json`
- Create: `bunfig.toml`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `README.md` (stub — full README in Task 19)

- [ ] **Step 1: Verify Bun is installed**

Run: `bun --version`
Expected: Prints `1.x.x` or higher. If missing, install with `curl -fsSL https://bun.sh/install | bash`.

- [ ] **Step 2: Create `package.json`**

```json
{
  "name": "open-cc-remote",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*"],
  "scripts": {
    "typecheck": "bun run --filter='*' typecheck",
    "test": "bun test",
    "lint": "echo 'lint todo'"
  },
  "devDependencies": {
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 3: Create `bunfig.toml`**

```toml
[test]
preload = []
coverage = false
```

- [ ] **Step 4: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "allowImportingTsExtensions": false,
    "noEmit": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "types": ["bun-types"]
  }
}
```

- [ ] **Step 5: Create `.gitignore`**

```
node_modules/
dist/
*.log
.DS_Store
.env
.env.local
~/.cc-remote/
```

- [ ] **Step 6: Create `README.md` stub**

```markdown
# open-cc-remote

Remote control plane for local Claude Code sessions. See [design spec](docs/superpowers/specs/2026-05-18-open-cc-remote-design.md).

Status: Plan 1 (foundation) — work in progress.

## Quickstart (Plan 1 milestone)

See `docs/superpowers/plans/2026-05-18-open-cc-remote-plan-01-foundation.md` Task 19.
```

- [ ] **Step 7: Install root deps and verify**

Run: `bun install`
Expected: Creates `bun.lock`, installs `typescript`. No errors.

- [ ] **Step 8: Commit**

```bash
git add package.json bunfig.toml tsconfig.base.json .gitignore README.md bun.lock
git commit -m "chore: scaffold bun monorepo"
```

---

## Task 2: `proto` package — wire frame types and codec

The plugin and daemon talk over a Unix socket using length-prefixed JSON (4-byte big-endian length, then UTF-8 JSON). The codec lives here, shared by both ends. Hub and PWA exchange JSON text over WebSocket — the framing is already provided by the WS protocol — but they share the same TS frame **types**.

**Files:**
- Create: `packages/proto/package.json`
- Create: `packages/proto/tsconfig.json`
- Create: `packages/proto/src/index.ts`
- Create: `packages/proto/src/frames.ts`
- Create: `packages/proto/src/codec.ts`
- Test: `packages/proto/tests/codec.test.ts`

- [ ] **Step 1: Create `packages/proto/package.json`**

```json
{
  "name": "@cc-remote/proto",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "bun-types": "latest"
  }
}
```

- [ ] **Step 2: Create `packages/proto/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*", "tests/**/*"]
}
```

- [ ] **Step 3: Create `packages/proto/src/frames.ts`** with Plan 1 subset

```typescript
// Subset of frames implemented in Plan 1.
// Auth, permission, history, file-transfer frames come in later plans.

export interface SessionSnapshot {
  session_id: string;
  tmux_session: string | null;
  tmux_pane: string | null;
  cwd: string;
  model: string;
  pid: number;
  started_at: number;
}

// ─── plugin ↔ daemon (Unix socket) ────────────────────────────────────

export type PluginToDaemon =
  | { type: "register"; session: SessionSnapshot }
  | { type: "bye"; session_id: string };

export type DaemonToPlugin =
  | { type: "ack"; ref: "register" | "bye" };

// ─── daemon ↔ hub (WSS) ───────────────────────────────────────────────

export type DaemonToHub =
  | { type: "hello"; daemon_id: string; epoch: number; hostname: string; agent_version: string; sessions: SessionSnapshot[] }
  | { type: "session_open"; session: SessionSnapshot }
  | { type: "session_close"; session_id: string; reason: string }
  | { type: "pong"; ts: number };

export type HubToDaemon =
  | { type: "ping"; ts: number };

// ─── hub ↔ PWA (WSS) ──────────────────────────────────────────────────

export interface DaemonView {
  daemon_id: string;
  hostname: string;
  online: boolean;
  sessions: SessionSnapshot[];
}

export type HubToPwa =
  | { type: "snapshot"; daemons: DaemonView[] }
  | { type: "daemon_online"; daemon_id: string; hostname: string; sessions: SessionSnapshot[] }
  | { type: "daemon_offline"; daemon_id: string }
  | { type: "session_open"; daemon_id: string; session: SessionSnapshot }
  | { type: "session_close"; daemon_id: string; session_id: string; reason: string };

export type PwaToHub =
  | { type: "subscribe" };  // Plan 1 PWA only subscribes; commands come in Plan 4
```

- [ ] **Step 4: Create `packages/proto/src/codec.ts`**

```typescript
// Length-prefixed JSON for Unix socket framing.
// Wire: [4-byte BE length][UTF-8 JSON payload]

const HEADER_BYTES = 4;
const MAX_FRAME_BYTES = 16 * 1024 * 1024; // 16MB hard ceiling

export function encodeFrame(value: unknown): Uint8Array {
  const json = JSON.stringify(value);
  const payload = new TextEncoder().encode(json);
  if (payload.byteLength > MAX_FRAME_BYTES) {
    throw new Error(`frame too large: ${payload.byteLength} > ${MAX_FRAME_BYTES}`);
  }
  const out = new Uint8Array(HEADER_BYTES + payload.byteLength);
  new DataView(out.buffer).setUint32(0, payload.byteLength, false);
  out.set(payload, HEADER_BYTES);
  return out;
}

export class FrameDecoder {
  private buffer: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): unknown[] {
    const merged = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.byteLength);
    this.buffer = merged;

    const out: unknown[] = [];
    while (this.buffer.byteLength >= HEADER_BYTES) {
      const len = new DataView(this.buffer.buffer, this.buffer.byteOffset, HEADER_BYTES).getUint32(0, false);
      if (len > MAX_FRAME_BYTES) {
        throw new Error(`frame too large: ${len}`);
      }
      if (this.buffer.byteLength < HEADER_BYTES + len) break;
      const payload = this.buffer.subarray(HEADER_BYTES, HEADER_BYTES + len);
      out.push(JSON.parse(new TextDecoder().decode(payload)));
      this.buffer = this.buffer.subarray(HEADER_BYTES + len);
    }
    return out;
  }
}
```

- [ ] **Step 5: Create `packages/proto/src/index.ts`**

```typescript
export * from "./frames.ts";
export * from "./codec.ts";
```

- [ ] **Step 6: Write the failing tests**

Create `packages/proto/tests/codec.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { encodeFrame, FrameDecoder } from "../src/codec.ts";

test("encode then decode round-trips", () => {
  const frame = { type: "register", session: { session_id: "s_1", cwd: "/x" } };
  const decoder = new FrameDecoder();
  const out = decoder.push(encodeFrame(frame));
  expect(out).toEqual([frame]);
});

test("decoder reassembles split chunks", () => {
  const frame = { hello: "world" };
  const bytes = encodeFrame(frame);
  const decoder = new FrameDecoder();
  expect(decoder.push(bytes.subarray(0, 2))).toEqual([]);
  expect(decoder.push(bytes.subarray(2, 5))).toEqual([]);
  expect(decoder.push(bytes.subarray(5))).toEqual([frame]);
});

test("decoder yields multiple frames in a single chunk", () => {
  const a = encodeFrame({ a: 1 });
  const b = encodeFrame({ b: 2 });
  const merged = new Uint8Array(a.byteLength + b.byteLength);
  merged.set(a, 0);
  merged.set(b, a.byteLength);
  const decoder = new FrameDecoder();
  expect(decoder.push(merged)).toEqual([{ a: 1 }, { b: 2 }]);
});

test("decoder rejects oversize length header", () => {
  const decoder = new FrameDecoder();
  const evil = new Uint8Array(4);
  new DataView(evil.buffer).setUint32(0, 999_999_999, false);
  expect(() => decoder.push(evil)).toThrow(/frame too large/);
});
```

- [ ] **Step 7: Run tests — they should pass**

Run: `cd packages/proto && bun install && bun test`
Expected: 4 passing tests.

(Tests pass on first run because we wrote the implementation before the tests in this task — protocol code is data definition, not behavior. We'll do strict TDD where it bites.)

- [ ] **Step 8: Commit**

```bash
git add packages/proto/
git commit -m "feat(proto): wire frame types and length-prefixed JSON codec"
```

---

## Task 3: Hub HTTP server with healthcheck

**Files:**
- Create: `packages/hub/package.json`
- Create: `packages/hub/tsconfig.json`
- Create: `packages/hub/src/index.ts`
- Create: `packages/hub/src/routes.ts`
- Test: `packages/hub/tests/routes.test.ts`

- [ ] **Step 1: Create `packages/hub/package.json`**

```json
{
  "name": "@cc-remote/hub",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "bun run src/index.ts",
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

- [ ] **Step 2: Create `packages/hub/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*", "tests/**/*"]
}
```

- [ ] **Step 3: Write the failing test**

Create `packages/hub/tests/routes.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { handle } from "../src/routes.ts";

test("GET /healthz returns 200 ok", async () => {
  const res = await handle(new Request("http://localhost/healthz"));
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("ok");
});

test("unknown path returns 404", async () => {
  const res = await handle(new Request("http://localhost/nope"));
  expect(res.status).toBe(404);
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd packages/hub && bun install && bun test`
Expected: FAIL — module `../src/routes.ts` not found.

- [ ] **Step 5: Create `packages/hub/src/routes.ts`**

```typescript
export async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/healthz" && req.method === "GET") {
    return new Response("ok", { status: 200 });
  }
  return new Response("not found", { status: 404 });
}
```

- [ ] **Step 6: Run test — it should pass**

Run: `bun test`
Expected: 2 passing tests.

- [ ] **Step 7: Create `packages/hub/src/index.ts`**

```typescript
import { handle } from "./routes.ts";

const PORT = Number(process.env.HUB_PORT ?? 7745);

const server = Bun.serve({
  port: PORT,
  fetch: (req) => handle(req),
});

console.log(`hub listening on http://localhost:${server.port}`);
```

- [ ] **Step 8: Smoke-test the server**

In one terminal: `bun run packages/hub/src/index.ts`
Expected: prints `hub listening on http://localhost:7745`

In another terminal: `curl -s http://localhost:7745/healthz`
Expected: `ok`

Stop the server with Ctrl-C.

- [ ] **Step 9: Commit**

```bash
git add packages/hub/
git commit -m "feat(hub): http server with healthcheck"
```

---

## Task 4: Hub connection registries (daemon + PWA)

**Files:**
- Create: `packages/hub/src/connections.ts`
- Test: `packages/hub/tests/connections.test.ts`

The hub needs to track which daemons and which PWAs are currently connected. Two registries: `daemonConnections` keyed by `daemon_id`, `pwaConnections` keyed by an opaque connection id.

- [ ] **Step 1: Write the failing test**

Create `packages/hub/tests/connections.test.ts`:

```typescript
import { test, expect, beforeEach } from "bun:test";
import { DaemonRegistry, PwaRegistry } from "../src/connections.ts";

interface FakeWs { id: string; sent: unknown[] }
const mkWs = (id: string): FakeWs => ({ id, sent: [] });
const sender = (ws: FakeWs) => (frame: unknown) => { ws.sent.push(frame); };

test("DaemonRegistry add/remove/lookup", () => {
  const reg = new DaemonRegistry<FakeWs>();
  const ws = mkWs("c1");
  reg.add("daemon-a", ws, sender(ws));
  expect(reg.has("daemon-a")).toBe(true);
  expect(reg.list()).toEqual(["daemon-a"]);
  reg.remove("daemon-a");
  expect(reg.has("daemon-a")).toBe(false);
});

test("DaemonRegistry replaces existing connection on duplicate add", () => {
  const reg = new DaemonRegistry<FakeWs>();
  const ws1 = mkWs("c1");
  const ws2 = mkWs("c2");
  let ws1Closed = false;
  reg.add("d", ws1, sender(ws1), () => { ws1Closed = true; });
  reg.add("d", ws2, sender(ws2));
  expect(ws1Closed).toBe(true);
  expect(reg.list()).toEqual(["d"]);
});

test("PwaRegistry assigns unique ids and broadcasts", () => {
  const reg = new PwaRegistry<FakeWs>();
  const a = mkWs("a"); const b = mkWs("b");
  const idA = reg.add(a, sender(a));
  const idB = reg.add(b, sender(b));
  expect(idA).not.toBe(idB);
  reg.broadcast({ type: "snapshot", daemons: [] });
  expect(a.sent).toEqual([{ type: "snapshot", daemons: [] }]);
  expect(b.sent).toEqual([{ type: "snapshot", daemons: [] }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/hub/tests/connections.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `packages/hub/src/connections.ts`**

```typescript
import type { HubToDaemon, HubToPwa } from "@cc-remote/proto";

type Sender<T> = (frame: T) => void;

interface Entry<W, T> {
  ws: W;
  send: Sender<T>;
  onEvict?: () => void;
}

export class DaemonRegistry<W> {
  private entries = new Map<string, Entry<W, HubToDaemon>>();

  add(daemon_id: string, ws: W, send: Sender<HubToDaemon>, onEvict?: () => void): void {
    const existing = this.entries.get(daemon_id);
    if (existing) existing.onEvict?.();
    this.entries.set(daemon_id, { ws, send, onEvict });
  }

  remove(daemon_id: string): void {
    this.entries.delete(daemon_id);
  }

  has(daemon_id: string): boolean {
    return this.entries.has(daemon_id);
  }

  list(): string[] {
    return [...this.entries.keys()];
  }

  send(daemon_id: string, frame: HubToDaemon): boolean {
    const e = this.entries.get(daemon_id);
    if (!e) return false;
    e.send(frame);
    return true;
  }
}

export class PwaRegistry<W> {
  private next = 1;
  private entries = new Map<string, Entry<W, HubToPwa>>();

  add(ws: W, send: Sender<HubToPwa>): string {
    const id = `pwa-${this.next++}`;
    this.entries.set(id, { ws, send });
    return id;
  }

  remove(id: string): void {
    this.entries.delete(id);
  }

  send(id: string, frame: HubToPwa): boolean {
    const e = this.entries.get(id);
    if (!e) return false;
    e.send(frame);
    return true;
  }

  broadcast(frame: HubToPwa): void {
    for (const e of this.entries.values()) e.send(frame);
  }
}
```

- [ ] **Step 4: Run tests — should pass**

Run: `bun test packages/hub/tests/connections.test.ts`
Expected: 3 passing tests.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/connections.ts packages/hub/tests/connections.test.ts
git commit -m "feat(hub): daemon and PWA connection registries"
```

---

## Task 5: Hub state model and router

The hub holds in-memory state of "what does each daemon know about its sessions" and translates daemon events into PWA broadcasts.

**Files:**
- Create: `packages/hub/src/router.ts`
- Test: `packages/hub/tests/router.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/hub/tests/router.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { Router } from "../src/router.ts";
import { DaemonRegistry, PwaRegistry } from "../src/connections.ts";

test("hello frame populates state and broadcasts daemon_online", () => {
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const broadcasts: unknown[] = [];
  const fakePwa = {} as object;
  preg.add(fakePwa, (f) => broadcasts.push(f));
  const router = new Router(dreg, preg);

  router.onDaemonFrame("d-1", {
    type: "hello",
    daemon_id: "d-1",
    epoch: 1,
    hostname: "macbook",
    agent_version: "0.1.0",
    sessions: [
      { session_id: "s1", tmux_session: "work", tmux_pane: "%0",
        cwd: "/x", model: "opus-4.7", pid: 1234, started_at: 1 }
    ]
  });

  expect(router.snapshot()).toEqual([
    { daemon_id: "d-1", hostname: "macbook", online: true,
      sessions: [{ session_id: "s1", tmux_session: "work", tmux_pane: "%0",
                   cwd: "/x", model: "opus-4.7", pid: 1234, started_at: 1 }]
    }
  ]);
  expect(broadcasts).toEqual([{
    type: "daemon_online", daemon_id: "d-1", hostname: "macbook",
    sessions: [{ session_id: "s1", tmux_session: "work", tmux_pane: "%0",
                 cwd: "/x", model: "opus-4.7", pid: 1234, started_at: 1 }]
  }]);
});

test("session_open broadcasts to PWAs", () => {
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const broadcasts: unknown[] = [];
  preg.add({}, (f) => broadcasts.push(f));
  const router = new Router(dreg, preg);

  router.onDaemonFrame("d-1", { type: "hello", daemon_id: "d-1", epoch: 1,
    hostname: "h", agent_version: "0", sessions: [] });
  broadcasts.length = 0;

  router.onDaemonFrame("d-1", {
    type: "session_open",
    session: { session_id: "s2", tmux_session: null, tmux_pane: null,
               cwd: "/y", model: "sonnet", pid: 99, started_at: 2 }
  });

  expect(broadcasts).toEqual([{
    type: "session_open",
    daemon_id: "d-1",
    session: { session_id: "s2", tmux_session: null, tmux_pane: null,
               cwd: "/y", model: "sonnet", pid: 99, started_at: 2 }
  }]);
});

test("daemon disconnect broadcasts daemon_offline and clears state", () => {
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const broadcasts: unknown[] = [];
  preg.add({}, (f) => broadcasts.push(f));
  const router = new Router(dreg, preg);

  router.onDaemonFrame("d-1", { type: "hello", daemon_id: "d-1", epoch: 1,
    hostname: "h", agent_version: "0", sessions: [] });
  broadcasts.length = 0;

  router.onDaemonDisconnect("d-1");
  expect(router.snapshot()).toEqual([]);
  expect(broadcasts).toEqual([{ type: "daemon_offline", daemon_id: "d-1" }]);
});

test("PWA subscribe receives current snapshot", () => {
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const router = new Router(dreg, preg);
  router.onDaemonFrame("d-1", { type: "hello", daemon_id: "d-1", epoch: 1,
    hostname: "h", agent_version: "0", sessions: [] });

  const sent: unknown[] = [];
  router.onPwaSubscribe((f) => sent.push(f));
  expect(sent).toEqual([{
    type: "snapshot",
    daemons: [{ daemon_id: "d-1", hostname: "h", online: true, sessions: [] }]
  }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/hub/tests/router.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `packages/hub/src/router.ts`**

```typescript
import type { DaemonToHub, HubToPwa, SessionSnapshot, DaemonView } from "@cc-remote/proto";
import type { DaemonRegistry, PwaRegistry } from "./connections.ts";

interface DaemonState {
  daemon_id: string;
  hostname: string;
  epoch: number;
  sessions: Map<string, SessionSnapshot>;
}

export class Router {
  private daemons = new Map<string, DaemonState>();

  constructor(
    private daemonReg: DaemonRegistry<unknown>,
    private pwaReg: PwaRegistry<unknown>,
  ) {}

  onDaemonFrame(daemon_id: string, frame: DaemonToHub): void {
    switch (frame.type) {
      case "hello": {
        const state: DaemonState = {
          daemon_id,
          hostname: frame.hostname,
          epoch: frame.epoch,
          sessions: new Map(frame.sessions.map((s) => [s.session_id, s])),
        };
        this.daemons.set(daemon_id, state);
        this.pwaReg.broadcast({
          type: "daemon_online",
          daemon_id,
          hostname: frame.hostname,
          sessions: frame.sessions,
        });
        return;
      }
      case "session_open": {
        const state = this.daemons.get(daemon_id);
        if (!state) return;
        state.sessions.set(frame.session.session_id, frame.session);
        this.pwaReg.broadcast({
          type: "session_open",
          daemon_id,
          session: frame.session,
        });
        return;
      }
      case "session_close": {
        const state = this.daemons.get(daemon_id);
        if (!state) return;
        state.sessions.delete(frame.session_id);
        this.pwaReg.broadcast({
          type: "session_close",
          daemon_id,
          session_id: frame.session_id,
          reason: frame.reason,
        });
        return;
      }
      case "pong":
        return; // Plan 1: heartbeat ignored
    }
  }

  onDaemonDisconnect(daemon_id: string): void {
    if (!this.daemons.has(daemon_id)) return;
    this.daemons.delete(daemon_id);
    this.pwaReg.broadcast({ type: "daemon_offline", daemon_id });
  }

  onPwaSubscribe(send: (f: HubToPwa) => void): void {
    send({ type: "snapshot", daemons: this.snapshot() });
  }

  snapshot(): DaemonView[] {
    return [...this.daemons.values()].map((d) => ({
      daemon_id: d.daemon_id,
      hostname: d.hostname,
      online: true,
      sessions: [...d.sessions.values()],
    }));
  }
}
```

- [ ] **Step 4: Run tests — should pass**

Run: `bun test packages/hub/tests/router.test.ts`
Expected: 4 passing tests.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/router.ts packages/hub/tests/router.test.ts
git commit -m "feat(hub): router fans daemon events out to PWAs"
```

---

## Task 6: Hub WSS endpoints

Wire up `/ws/daemon` and `/ws/pwa` to the registries and router. No auth in Plan 1; daemons identify themselves via a `?daemon_id=...` query param.

**Files:**
- Modify: `packages/hub/src/routes.ts`
- Modify: `packages/hub/src/index.ts`

- [ ] **Step 1: Replace `packages/hub/src/routes.ts`**

```typescript
import type { ServerWebSocket } from "bun";
import type { DaemonToHub, PwaToHub } from "@cc-remote/proto";
import { DaemonRegistry, PwaRegistry } from "./connections.ts";
import { Router } from "./router.ts";

type WsKind = "daemon" | "pwa";
interface WsData { kind: WsKind; key: string; }

export function makeServer() {
  const daemonReg = new DaemonRegistry<ServerWebSocket<WsData>>();
  const pwaReg = new PwaRegistry<ServerWebSocket<WsData>>();
  const router = new Router(daemonReg, pwaReg);

  const fetch = (req: Request, server: ReturnType<typeof Bun.serve>) => {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return new Response("ok");
    if (url.pathname === "/ws/daemon") {
      const id = url.searchParams.get("daemon_id");
      if (!id) return new Response("daemon_id required", { status: 400 });
      const ok = server.upgrade(req, { data: { kind: "daemon", key: id } satisfies WsData });
      return ok ? undefined : new Response("upgrade failed", { status: 500 });
    }
    if (url.pathname === "/ws/pwa") {
      const ok = server.upgrade(req, { data: { kind: "pwa", key: "" } satisfies WsData });
      return ok ? undefined : new Response("upgrade failed", { status: 500 });
    }
    return new Response("not found", { status: 404 });
  };

  const websocket = {
    open(ws: ServerWebSocket<WsData>) {
      if (ws.data.kind === "daemon") {
        daemonReg.add(ws.data.key, ws, (f) => ws.send(JSON.stringify(f)),
          () => ws.close(1000, "replaced"));
      } else {
        const id = pwaReg.add(ws, (f) => ws.send(JSON.stringify(f)));
        ws.data = { kind: "pwa", key: id };
      }
    },
    message(ws: ServerWebSocket<WsData>, msg: string | Buffer) {
      const text = typeof msg === "string" ? msg : msg.toString("utf8");
      let frame: unknown;
      try { frame = JSON.parse(text); } catch { ws.close(1003, "bad json"); return; }
      if (ws.data.kind === "daemon") {
        router.onDaemonFrame(ws.data.key, frame as DaemonToHub);
      } else {
        const pf = frame as PwaToHub;
        if (pf.type === "subscribe") router.onPwaSubscribe((f) => ws.send(JSON.stringify(f)));
      }
    },
    close(ws: ServerWebSocket<WsData>) {
      if (ws.data.kind === "daemon") {
        daemonReg.remove(ws.data.key);
        router.onDaemonDisconnect(ws.data.key);
      } else {
        pwaReg.remove(ws.data.key);
      }
    },
  };

  return { fetch, websocket };
}

// Legacy export kept for Task 3 unit test stability.
export async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/healthz" && req.method === "GET") return new Response("ok");
  return new Response("not found", { status: 404 });
}
```

- [ ] **Step 2: Replace `packages/hub/src/index.ts`**

```typescript
import { makeServer } from "./routes.ts";

const PORT = Number(process.env.HUB_PORT ?? 7745);
const { fetch, websocket } = makeServer();

const server = Bun.serve({ port: PORT, fetch, websocket });
console.log(`hub listening on http://localhost:${server.port}`);
```

- [ ] **Step 3: Smoke-test daemon connect**

Terminal A: `bun run packages/hub/src/index.ts`

Terminal B:
```bash
bun -e '
const ws = new WebSocket("ws://localhost:7745/ws/daemon?daemon_id=test");
ws.onopen = () => {
  ws.send(JSON.stringify({
    type: "hello", daemon_id: "test", epoch: 1, hostname: "h",
    agent_version: "0", sessions: []
  }));
  console.log("sent hello");
  setTimeout(() => process.exit(0), 200);
};
'
```

Expected: prints `sent hello`. Hub stays up. No error.

Stop the server.

- [ ] **Step 4: Run all tests**

Run: `bun test`
Expected: all tests still pass.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/
git commit -m "feat(hub): WSS endpoints for daemon and PWA"
```

---

## Task 7: Daemon — config and entry skeleton

**Files:**
- Create: `packages/daemon/package.json`
- Create: `packages/daemon/tsconfig.json`
- Create: `packages/daemon/src/config.ts`
- Create: `packages/daemon/src/index.ts`
- Test: `packages/daemon/tests/config.test.ts`

In Plan 1 the daemon reads minimal config: `daemon_id` and `hub_url`. No TOML parser yet — we use `~/.cc-remote/config.json` to keep dependencies low until Plan 2 introduces full TOML.

- [ ] **Step 1: Create `packages/daemon/package.json`**

```json
{
  "name": "@cc-remote/daemon",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "bun run src/index.ts",
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

- [ ] **Step 2: Create `packages/daemon/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*", "tests/**/*"]
}
```

- [ ] **Step 3: Write the failing test**

Create `packages/daemon/tests/config.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";

test("loadConfig reads daemon_id and hub_url from JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-"));
  try {
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      daemon_id: "macbook-pro",
      hub_url: "ws://localhost:7745",
    }));
    const cfg = loadConfig(dir);
    expect(cfg.daemon_id).toBe("macbook-pro");
    expect(cfg.hub_url).toBe("ws://localhost:7745");
    expect(cfg.socket_path).toBe(join(dir, "daemon.sock"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig throws when file missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-"));
  try {
    expect(() => loadConfig(dir)).toThrow(/config\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd packages/daemon && bun install && bun test`
Expected: FAIL — module not found.

- [ ] **Step 5: Create `packages/daemon/src/config.ts`**

```typescript
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface DaemonConfig {
  daemon_id: string;
  hub_url: string;
  state_dir: string;
  socket_path: string;
}

export function defaultStateDir(): string {
  return process.env.CC_REMOTE_STATE_DIR ?? join(homedir(), ".cc-remote");
}

export function loadConfig(stateDir: string = defaultStateDir()): DaemonConfig {
  const path = join(stateDir, "config.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`could not read ${path}: ${(e as Error).message}`);
  }
  const data = JSON.parse(raw) as { daemon_id?: string; hub_url?: string };
  if (!data.daemon_id) throw new Error(`config.json missing daemon_id`);
  if (!data.hub_url) throw new Error(`config.json missing hub_url`);
  return {
    daemon_id: data.daemon_id,
    hub_url: data.hub_url,
    state_dir: stateDir,
    socket_path: join(stateDir, "daemon.sock"),
  };
}
```

- [ ] **Step 6: Create stub `packages/daemon/src/index.ts`**

```typescript
import { loadConfig } from "./config.ts";

const cfg = loadConfig();
console.log(`daemon ${cfg.daemon_id} starting; will connect ${cfg.hub_url}`);
console.log(`socket path: ${cfg.socket_path}`);
// Real wiring in Tasks 8–10.
```

- [ ] **Step 7: Run tests**

Run: `bun test`
Expected: 2 passing tests.

- [ ] **Step 8: Commit**

```bash
git add packages/daemon/
git commit -m "feat(daemon): config loader and entry skeleton"
```

---

## Task 8: Daemon — in-memory session registry

**Files:**
- Create: `packages/daemon/src/registry.ts`
- Test: `packages/daemon/tests/registry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/daemon/tests/registry.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { LiveSessions } from "../src/registry.ts";
import type { SessionSnapshot } from "@cc-remote/proto";

const make = (id: string): SessionSnapshot => ({
  session_id: id,
  tmux_session: null, tmux_pane: null,
  cwd: "/x", model: "opus-4.7", pid: 1, started_at: 1,
});

test("add/get/remove", () => {
  const reg = new LiveSessions();
  reg.add(make("a"));
  expect(reg.get("a")?.session_id).toBe("a");
  expect(reg.list()).toHaveLength(1);
  reg.remove("a");
  expect(reg.get("a")).toBeUndefined();
});

test("emits onAdd / onRemove", () => {
  const reg = new LiveSessions();
  const added: string[] = []; const removed: string[] = [];
  reg.onAdd((s) => added.push(s.session_id));
  reg.onRemove((id) => removed.push(id));
  reg.add(make("x"));
  reg.remove("x");
  expect(added).toEqual(["x"]);
  expect(removed).toEqual(["x"]);
});

test("ignores duplicate add of same session_id", () => {
  const reg = new LiveSessions();
  let count = 0; reg.onAdd(() => count++);
  reg.add(make("a"));
  reg.add(make("a"));
  expect(count).toBe(1);
  expect(reg.list()).toHaveLength(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/daemon/tests/registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `packages/daemon/src/registry.ts`**

```typescript
import type { SessionSnapshot } from "@cc-remote/proto";

type AddListener = (s: SessionSnapshot) => void;
type RemoveListener = (session_id: string) => void;

export class LiveSessions {
  private sessions = new Map<string, SessionSnapshot>();
  private adds: AddListener[] = [];
  private removes: RemoveListener[] = [];

  add(s: SessionSnapshot): void {
    if (this.sessions.has(s.session_id)) return;
    this.sessions.set(s.session_id, s);
    for (const l of this.adds) l(s);
  }

  remove(session_id: string): void {
    if (!this.sessions.has(session_id)) return;
    this.sessions.delete(session_id);
    for (const l of this.removes) l(session_id);
  }

  get(session_id: string): SessionSnapshot | undefined {
    return this.sessions.get(session_id);
  }

  list(): SessionSnapshot[] {
    return [...this.sessions.values()];
  }

  onAdd(l: AddListener): void { this.adds.push(l); }
  onRemove(l: RemoveListener): void { this.removes.push(l); }
}
```

- [ ] **Step 4: Run tests — should pass**

Run: `bun test packages/daemon/tests/registry.test.ts`
Expected: 3 passing tests.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/registry.ts packages/daemon/tests/registry.test.ts
git commit -m "feat(daemon): in-memory live sessions registry"
```

---

## Task 9: Daemon — Unix socket server for plugin

**Files:**
- Create: `packages/daemon/src/socket-server.ts`
- Test: `packages/daemon/tests/socket-server.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/daemon/tests/socket-server.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { encodeFrame, FrameDecoder } from "@cc-remote/proto";
import type { PluginToDaemon, DaemonToPlugin } from "@cc-remote/proto";
import { startSocketServer } from "../src/socket-server.ts";

function tmpSocket() {
  const dir = mkdtempSync(join(tmpdir(), "ccr-sock-"));
  return { dir, path: join(dir, "test.sock"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("plugin register frame triggers handler and ack reply", async () => {
  const t = tmpSocket();
  try {
    const received: PluginToDaemon[] = [];
    const server = startSocketServer({
      path: t.path,
      onFrame: (frame) => { received.push(frame); },
    });
    await server.ready;

    const client = connect(t.path);
    const decoder = new FrameDecoder();
    const acks: DaemonToPlugin[] = [];
    client.on("data", (chunk) => {
      for (const f of decoder.push(chunk)) acks.push(f as DaemonToPlugin);
    });
    await new Promise<void>((res) => client.once("connect", () => res()));

    const reg: PluginToDaemon = {
      type: "register",
      session: { session_id: "s1", tmux_session: null, tmux_pane: null,
                 cwd: "/x", model: "m", pid: 1, started_at: 1 }
    };
    client.write(encodeFrame(reg));
    server.replyTo(client, { type: "ack", ref: "register" });

    await new Promise((res) => setTimeout(res, 50));
    client.end();
    server.close();

    expect(received).toEqual([reg]);
    expect(acks).toEqual([{ type: "ack", ref: "register" }]);
  } finally { t.cleanup(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/daemon/tests/socket-server.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `packages/daemon/src/socket-server.ts`**

```typescript
import { createServer, type Server, type Socket } from "node:net";
import { unlinkSync } from "node:fs";
import { encodeFrame, FrameDecoder } from "@cc-remote/proto";
import type { PluginToDaemon, DaemonToPlugin } from "@cc-remote/proto";

export interface SocketServerOptions {
  path: string;
  onFrame: (frame: PluginToDaemon, client: Socket) => void;
  onClose?: (client: Socket) => void;
}

export interface SocketServerHandle {
  ready: Promise<void>;
  close(): void;
  replyTo(client: Socket, frame: DaemonToPlugin): void;
}

export function startSocketServer(opts: SocketServerOptions): SocketServerHandle {
  try { unlinkSync(opts.path); } catch {}

  const server: Server = createServer((sock) => {
    const decoder = new FrameDecoder();
    sock.on("data", (chunk) => {
      try {
        for (const frame of decoder.push(chunk)) {
          opts.onFrame(frame as PluginToDaemon, sock);
        }
      } catch (e) {
        sock.destroy(e as Error);
      }
    });
    sock.on("close", () => opts.onClose?.(sock));
    sock.on("error", () => sock.destroy());
  });

  const ready = new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.path, () => {
      // Tighten permissions: owner-only.
      try {
        const { chmodSync } = require("node:fs");
        chmodSync(opts.path, 0o600);
      } catch {}
      resolve();
    });
  });

  return {
    ready,
    close() {
      server.close();
      try { unlinkSync(opts.path); } catch {}
    },
    replyTo(client: Socket, frame: DaemonToPlugin) {
      client.write(encodeFrame(frame));
    },
  };
}
```

- [ ] **Step 4: Run tests — should pass**

Run: `bun test packages/daemon/tests/socket-server.test.ts`
Expected: 1 passing test.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/socket-server.ts packages/daemon/tests/socket-server.test.ts
git commit -m "feat(daemon): unix socket server with frame decoding"
```

---

## Task 10: Daemon — WSS client to hub with reconnect

**Files:**
- Create: `packages/daemon/src/hub-client.ts`
- Test: `packages/daemon/tests/hub-client.test.ts`

The hub client opens a `ws://hub/ws/daemon?daemon_id=...` connection, sends a `hello` frame on (re)connect, dispatches inbound frames to a handler, and reconnects on close with exponential backoff (1s → 2s → 4s → … → 30s cap).

- [ ] **Step 1: Write the failing test**

Create `packages/daemon/tests/hub-client.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { startHubClient } from "../src/hub-client.ts";
import type { DaemonToHub } from "@cc-remote/proto";

test("connects, sends hello on open, reconnects on server close", async () => {
  const helloEvents: DaemonToHub[] = [];
  let firstSocket: any = null; let connectCount = 0;

  const server = Bun.serve<{ first: boolean }>({
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname !== "/ws/daemon") return new Response("nope", { status: 404 });
      const ok = srv.upgrade(req, { data: { first: connectCount === 0 } });
      return ok ? undefined : new Response("upgrade fail", { status: 500 });
    },
    websocket: {
      open(ws) {
        connectCount++;
        if (ws.data.first) firstSocket = ws;
      },
      message(ws, msg) {
        helloEvents.push(JSON.parse(typeof msg === "string" ? msg : msg.toString()) as DaemonToHub);
      },
      close() {},
    },
  });

  try {
    const client = startHubClient({
      hub_url: `ws://localhost:${server.port}`,
      daemon_id: "d-1",
      hello: () => ({ type: "hello", daemon_id: "d-1", epoch: 1,
        hostname: "h", agent_version: "0", sessions: [] }),
      onFrame: () => {},
      backoffStartMs: 50,
      backoffCapMs: 200,
    });

    // Wait for first hello.
    await waitFor(() => helloEvents.length === 1, 2000);
    expect(helloEvents[0]).toMatchObject({ type: "hello", daemon_id: "d-1" });

    // Force-close from server side.
    firstSocket.close(1011, "test-disconnect");
    // Expect a reconnection and a second hello.
    await waitFor(() => helloEvents.length === 2, 2000);
    expect(connectCount).toBeGreaterThanOrEqual(2);

    client.close();
  } finally {
    server.stop(true);
  }
});

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/daemon/tests/hub-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `packages/daemon/src/hub-client.ts`**

```typescript
import type { DaemonToHub, HubToDaemon } from "@cc-remote/proto";

export interface HubClientOptions {
  hub_url: string;
  daemon_id: string;
  hello: () => DaemonToHub;
  onFrame: (frame: HubToDaemon) => void;
  backoffStartMs?: number;
  backoffCapMs?: number;
}

export interface HubClientHandle {
  send(frame: DaemonToHub): boolean;
  close(): void;
  isConnected(): boolean;
}

export function startHubClient(opts: HubClientOptions): HubClientHandle {
  const startMs = opts.backoffStartMs ?? 1000;
  const capMs = opts.backoffCapMs ?? 30_000;
  let backoff = startMs;
  let stopped = false;
  let ws: WebSocket | null = null;
  let pending: DaemonToHub[] = [];

  const url = `${opts.hub_url.replace(/\/$/, "")}/ws/daemon?daemon_id=${encodeURIComponent(opts.daemon_id)}`;

  const connect = () => {
    if (stopped) return;
    ws = new WebSocket(url);

    ws.addEventListener("open", () => {
      backoff = startMs;
      ws!.send(JSON.stringify(opts.hello()));
      while (pending.length > 0) {
        const f = pending.shift()!;
        ws!.send(JSON.stringify(f));
      }
    });

    ws.addEventListener("message", (ev) => {
      try {
        const data = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
        opts.onFrame(JSON.parse(data) as HubToDaemon);
      } catch {}
    });

    const reconnect = () => {
      ws = null;
      if (stopped) return;
      const delay = backoff;
      backoff = Math.min(backoff * 2, capMs);
      setTimeout(connect, delay);
    };
    ws.addEventListener("close", reconnect);
    ws.addEventListener("error", () => { try { ws?.close(); } catch {} });
  };

  connect();

  return {
    send(frame) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(frame));
        return true;
      }
      pending.push(frame);
      return false;
    },
    close() {
      stopped = true;
      try { ws?.close(); } catch {}
    },
    isConnected() {
      return !!ws && ws.readyState === WebSocket.OPEN;
    },
  };
}
```

- [ ] **Step 4: Run tests — should pass**

Run: `bun test packages/daemon/tests/hub-client.test.ts`
Expected: 1 passing test.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/hub-client.ts packages/daemon/tests/hub-client.test.ts
git commit -m "feat(daemon): hub WSS client with reconnect"
```

---

## Task 11: Daemon — wire registry, socket server, and hub client together

**Files:**
- Modify: `packages/daemon/src/index.ts`

The entry now:
1. Loads config
2. Starts the Unix socket server, handling `register` / `bye` frames
3. Adds/removes sessions in `LiveSessions`
4. Starts the hub client, providing `hello` from registry state
5. On every registry change while connected, sends `session_open` / `session_close`

- [ ] **Step 1: Replace `packages/daemon/src/index.ts`**

```typescript
import { hostname } from "node:os";
import type { DaemonToHub, PluginToDaemon, SessionSnapshot } from "@cc-remote/proto";
import { loadConfig } from "./config.ts";
import { LiveSessions } from "./registry.ts";
import { startSocketServer } from "./socket-server.ts";
import { startHubClient } from "./hub-client.ts";

const cfg = loadConfig();
const epoch = Math.floor(Date.now() / 1000);
const sessions = new LiveSessions();

const hub = startHubClient({
  hub_url: cfg.hub_url,
  daemon_id: cfg.daemon_id,
  hello: () => ({
    type: "hello",
    daemon_id: cfg.daemon_id,
    epoch,
    hostname: hostname(),
    agent_version: "0.1.0",
    sessions: sessions.list(),
  }),
  onFrame: (_frame) => {
    // Plan 1: hub-to-daemon frames (ping etc.) ignored.
  },
});

sessions.onAdd((s: SessionSnapshot) => {
  hub.send({ type: "session_open", session: s });
});
sessions.onRemove((session_id: string) => {
  hub.send({ type: "session_close", session_id, reason: "plugin_bye" });
});

const sockServer = startSocketServer({
  path: cfg.socket_path,
  onFrame: (frame: PluginToDaemon, client) => {
    if (frame.type === "register") {
      sessions.add(frame.session);
      sockServer.replyTo(client, { type: "ack", ref: "register" });
    } else if (frame.type === "bye") {
      sessions.remove(frame.session_id);
      sockServer.replyTo(client, { type: "ack", ref: "bye" });
    }
  },
  onClose: () => {
    // Plan 1 simplification: rely on explicit `bye`. Plan 2 adds
    // per-connection session tracking for ungraceful disconnects.
  },
});

await sockServer.ready;
console.log(`daemon ${cfg.daemon_id} ready; socket=${cfg.socket_path}; hub=${cfg.hub_url}`);

const shutdown = () => {
  sockServer.close();
  hub.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
```

- [ ] **Step 2: Run all daemon tests**

Run: `bun test packages/daemon`
Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/daemon/src/index.ts
git commit -m "feat(daemon): wire socket server + registry + hub client"
```

---

## Task 12: Plugin — daemon-client (Unix socket helper)

**Files:**
- Create: `packages/plugin/package.json`
- Create: `packages/plugin/tsconfig.json`
- Create: `packages/plugin/src/daemon-client.ts`
- Test: `packages/plugin/tests/daemon-client.test.ts`

- [ ] **Step 1: Create `packages/plugin/package.json`**

```json
{
  "name": "@cc-remote/plugin",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "bun run src/index.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@cc-remote/proto": "workspace:*",
    "@modelcontextprotocol/sdk": "^1.0.0"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "bun-types": "latest"
  }
}
```

- [ ] **Step 2: Create `packages/plugin/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*", "tests/**/*"]
}
```

- [ ] **Step 3: Write the failing test**

Create `packages/plugin/tests/daemon-client.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSocketServer } from "../../daemon/src/socket-server.ts";
import { connectDaemon } from "../src/daemon-client.ts";
import type { PluginToDaemon } from "@cc-remote/proto";

test("connect, register, bye, close round-trip", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-pc-"));
  const sockPath = join(dir, "d.sock");
  try {
    const seen: PluginToDaemon[] = [];
    const server = startSocketServer({
      path: sockPath,
      onFrame: (f, c) => { seen.push(f); server.replyTo(c, { type: "ack", ref: f.type }); },
    });
    await server.ready;

    const client = await connectDaemon(sockPath);
    const ack1 = await client.send({
      type: "register",
      session: { session_id: "s1", tmux_session: null, tmux_pane: null,
                 cwd: "/x", model: "m", pid: 1, started_at: 1 }
    });
    expect(ack1).toEqual({ type: "ack", ref: "register" });

    const ack2 = await client.send({ type: "bye", session_id: "s1" });
    expect(ack2).toEqual({ type: "ack", ref: "bye" });

    client.close();
    server.close();
    expect(seen.map((f) => f.type)).toEqual(["register", "bye"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd packages/plugin && bun install && bun test`
Expected: FAIL — module not found.

- [ ] **Step 5: Create `packages/plugin/src/daemon-client.ts`**

```typescript
import { connect, type Socket } from "node:net";
import { encodeFrame, FrameDecoder } from "@cc-remote/proto";
import type { PluginToDaemon, DaemonToPlugin } from "@cc-remote/proto";

export interface DaemonClient {
  send(frame: PluginToDaemon): Promise<DaemonToPlugin>;
  close(): void;
}

export async function connectDaemon(socketPath: string, timeoutMs = 5000): Promise<DaemonClient> {
  const sock = await new Promise<Socket>((resolve, reject) => {
    const s = connect(socketPath);
    const tid = setTimeout(() => { s.destroy(); reject(new Error("connect timeout")); }, timeoutMs);
    s.once("connect", () => { clearTimeout(tid); resolve(s); });
    s.once("error", (e) => { clearTimeout(tid); reject(e); });
  });

  const decoder = new FrameDecoder();
  const queue: Array<(f: DaemonToPlugin) => void> = [];

  sock.on("data", (chunk) => {
    try {
      for (const f of decoder.push(chunk)) {
        const cb = queue.shift();
        if (cb) cb(f as DaemonToPlugin);
      }
    } catch (e) { sock.destroy(e as Error); }
  });

  sock.on("close", () => {
    while (queue.length) queue.shift()!({ type: "ack", ref: "bye" } as DaemonToPlugin);
    // No surprise rejections; treat post-close acks as bye-acks.
  });

  return {
    send(frame: PluginToDaemon) {
      return new Promise<DaemonToPlugin>((resolve) => {
        queue.push(resolve);
        sock.write(encodeFrame(frame));
      });
    },
    close() { try { sock.end(); } catch {} },
  };
}
```

- [ ] **Step 6: Run tests — should pass**

Run: `bun test packages/plugin/tests/daemon-client.test.ts`
Expected: 1 passing test.

- [ ] **Step 7: Commit**

```bash
git add packages/plugin/
git commit -m "feat(plugin): daemon unix socket client"
```

---

## Task 13: Plugin — MCP entry, register on startup, bye on shutdown

**Files:**
- Create: `packages/plugin/src/index.ts`

The plugin reads the channel-plugin environment Claude Code passes when invoking it. Per the official channel plugins, env includes:
- `CLAUDE_SESSION_ID` — Claude Code session id
- `CLAUDE_PROJECT_DIR` — cwd of the session
- `CLAUDE_MODEL` — model id
- `TMUX` / `TMUX_PANE` — when launched inside tmux

Plan 1 plugin doesn't expose any MCP tools yet. It just registers and stays alive until stdin closes.

- [ ] **Step 1: Create `packages/plugin/src/index.ts`**

```typescript
#!/usr/bin/env bun
import { join } from "node:path";
import { homedir } from "node:os";
import type { SessionSnapshot } from "@cc-remote/proto";
import { connectDaemon, type DaemonClient } from "./daemon-client.ts";

function envOr(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function buildSession(): SessionSnapshot {
  return {
    session_id: envOr("CLAUDE_SESSION_ID", `unknown-${process.pid}`),
    tmux_session: process.env.TMUX_SESSION ?? null,
    tmux_pane: process.env.TMUX_PANE ?? null,
    cwd: envOr("CLAUDE_PROJECT_DIR", process.cwd()),
    model: envOr("CLAUDE_MODEL", "unknown"),
    pid: process.pid,
    started_at: Math.floor(Date.now() / 1000),
  };
}

async function main() {
  const sockPath = process.env.CC_REMOTE_SOCKET ?? join(homedir(), ".cc-remote", "daemon.sock");
  let client: DaemonClient;
  try {
    client = await connectDaemon(sockPath, 3000);
  } catch (e) {
    process.stderr.write(`cc-remote plugin: cannot reach daemon at ${sockPath}: ${(e as Error).message}\n`);
    // Plan 1: exit cleanly so Claude Code is unaffected.
    process.exit(0);
  }

  const session = buildSession();
  await client.send({ type: "register", session });
  process.stderr.write(`cc-remote plugin: registered session ${session.session_id}\n`);

  const goodbye = async (code: number) => {
    try {
      await Promise.race([
        client.send({ type: "bye", session_id: session.session_id }),
        new Promise((r) => setTimeout(r, 500)),
      ]);
    } catch {}
    client.close();
    process.exit(code);
  };

  process.stdin.on("end", () => goodbye(0));
  process.on("SIGINT", () => goodbye(130));
  process.on("SIGTERM", () => goodbye(143));

  // Keep the event loop alive: read stdin (Claude Code uses stdio for MCP framing
  // in real plugins; we ignore it for Plan 1).
  process.stdin.resume();
}

main().catch((e) => {
  process.stderr.write(`cc-remote plugin: ${(e as Error).message}\n`);
  process.exit(1);
});
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd packages/plugin && bun run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/plugin/src/index.ts
git commit -m "feat(plugin): register on startup, bye on shutdown"
```

> **Note:** Real MCP tool surface (`reply`, `ack`, `edit_last`) is added in Plan 3 / Plan 4. For Plan 1 the plugin only proves the connection.

---

## Task 14: PWA — Vite scaffold

**Files:**
- Create: `packages/pwa/package.json`
- Create: `packages/pwa/tsconfig.json`
- Create: `packages/pwa/vite.config.ts`
- Create: `packages/pwa/index.html`
- Create: `packages/pwa/src/main.tsx`
- Create: `packages/pwa/src/App.tsx`

- [ ] **Step 1: Create `packages/pwa/package.json`**

```json
{
  "name": "@cc-remote/pwa",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@cc-remote/proto": "workspace:*",
    "react": "^18.3.0",
    "react-dom": "^18.3.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "^5.4.0",
    "vite": "^5.4.0"
  }
}
```

- [ ] **Step 2: Create `packages/pwa/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": []
  },
  "include": ["src/**/*", "vite.config.ts"]
}
```

- [ ] **Step 3: Create `packages/pwa/vite.config.ts`**

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
});
```

- [ ] **Step 4: Create `packages/pwa/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>cc-remote</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: Create `packages/pwa/src/main.tsx`**

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.tsx";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

- [ ] **Step 6: Create temporary `packages/pwa/src/App.tsx` (replaced in Task 16)**

```tsx
export function App() {
  return <h1>cc-remote (Plan 1 placeholder)</h1>;
}
```

- [ ] **Step 7: Install and verify dev server**

Run: `bun install`
Run: `bun run --filter=@cc-remote/pwa dev`
Expected: Vite reports `Local: http://localhost:5173/`. Open in browser: see "cc-remote (Plan 1 placeholder)".

Stop with Ctrl-C.

- [ ] **Step 8: Commit**

```bash
git add packages/pwa/ bun.lock
git commit -m "feat(pwa): vite + react scaffold"
```

---

## Task 15: PWA — WS client hook

**Files:**
- Create: `packages/pwa/src/ws.ts`

This task uses no dedicated tests — the integration is verified through the e2e in Task 18. Functionality is small enough to reason about by inspection.

- [ ] **Step 1: Create `packages/pwa/src/ws.ts`**

```typescript
import { useEffect, useRef, useState } from "react";
import type { HubToPwa, PwaToHub, DaemonView } from "@cc-remote/proto";

export interface HubState {
  connected: boolean;
  daemons: DaemonView[];
}

export function useHub(hubUrl: string): HubState {
  const [state, setState] = useState<HubState>({ connected: false, daemons: [] });
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let stopped = false;
    let backoff = 500;

    const apply = (frame: HubToPwa) => {
      setState((prev) => {
        switch (frame.type) {
          case "snapshot":
            return { ...prev, daemons: frame.daemons };
          case "daemon_online":
            return {
              ...prev,
              daemons: [
                ...prev.daemons.filter((d) => d.daemon_id !== frame.daemon_id),
                { daemon_id: frame.daemon_id, hostname: frame.hostname,
                  online: true, sessions: frame.sessions },
              ],
            };
          case "daemon_offline":
            return {
              ...prev,
              daemons: prev.daemons.map((d) =>
                d.daemon_id === frame.daemon_id ? { ...d, online: false } : d),
            };
          case "session_open":
            return {
              ...prev,
              daemons: prev.daemons.map((d) =>
                d.daemon_id === frame.daemon_id
                  ? { ...d, sessions: [...d.sessions.filter((s) => s.session_id !== frame.session.session_id), frame.session] }
                  : d),
            };
          case "session_close":
            return {
              ...prev,
              daemons: prev.daemons.map((d) =>
                d.daemon_id === frame.daemon_id
                  ? { ...d, sessions: d.sessions.filter((s) => s.session_id !== frame.session_id) }
                  : d),
            };
        }
        return prev;
      });
    };

    const connect = () => {
      if (stopped) return;
      const ws = new WebSocket(hubUrl + "/ws/pwa");
      wsRef.current = ws;

      ws.onopen = () => {
        backoff = 500;
        setState((s) => ({ ...s, connected: true }));
        const sub: PwaToHub = { type: "subscribe" };
        ws.send(JSON.stringify(sub));
      };
      ws.onmessage = (ev) => {
        try { apply(JSON.parse(ev.data) as HubToPwa); } catch {}
      };
      const reconnect = () => {
        wsRef.current = null;
        setState((s) => ({ ...s, connected: false }));
        if (stopped) return;
        const delay = backoff;
        backoff = Math.min(backoff * 2, 10_000);
        setTimeout(connect, delay);
      };
      ws.onclose = reconnect;
      ws.onerror = () => { try { ws.close(); } catch {} };
    };

    connect();
    return () => { stopped = true; try { wsRef.current?.close(); } catch {} };
  }, [hubUrl]);

  return state;
}
```

- [ ] **Step 2: Verify typecheck**

Run: `bun run --filter=@cc-remote/pwa typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/pwa/src/ws.ts
git commit -m "feat(pwa): hub websocket hook"
```

---

## Task 16: PWA — session list view

**Files:**
- Modify: `packages/pwa/src/App.tsx`

- [ ] **Step 1: Replace `packages/pwa/src/App.tsx`**

```tsx
import { useHub } from "./ws.ts";

const HUB_URL = (import.meta.env.VITE_HUB_URL as string) ?? "ws://localhost:7745";

export function App() {
  const { connected, daemons } = useHub(HUB_URL);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24, maxWidth: 720 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h1 style={{ margin: 0 }}>cc-remote</h1>
        <span data-testid="conn-status" style={{ color: connected ? "#0a0" : "#a00" }}>
          {connected ? "connected" : "disconnected"}
        </span>
      </header>

      {daemons.length === 0 ? (
        <p>No daemons connected yet. Start `bun run packages/daemon/src/index.ts`.</p>
      ) : (
        daemons.map((d) => (
          <section key={d.daemon_id} style={{ marginTop: 24 }}>
            <h2 style={{ margin: "0 0 8px" }}>
              {d.hostname}{" "}
              <small style={{ color: d.online ? "#0a0" : "#888" }}>
                ({d.daemon_id} · {d.online ? "online" : "offline"})
              </small>
            </h2>
            {d.sessions.length === 0 ? (
              <p style={{ color: "#666" }}>No active sessions.</p>
            ) : (
              <ul data-testid={`sessions-${d.daemon_id}`}>
                {d.sessions.map((s) => (
                  <li key={s.session_id}>
                    <code>{s.session_id}</code>{" — "}
                    {s.tmux_session ? <span>tmux:{s.tmux_session} · </span> : null}
                    cwd: <code>{s.cwd}</code> · model: <code>{s.model}</code>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))
      )}
    </main>
  );
}
```

- [ ] **Step 2: Verify typecheck and visual**

Run: `bun run --filter=@cc-remote/pwa typecheck`
Expected: no errors.

(Manual visual confirmation happens in Task 19's e2e runbook.)

- [ ] **Step 3: Commit**

```bash
git add packages/pwa/src/App.tsx
git commit -m "feat(pwa): session list view"
```

---

## Task 17: fake-claude test harness

**Files:**
- Create: `tools/fake-claude/fake-claude.ts`

The harness spawns the plugin as a subprocess, simulating how Claude Code launches it. Used by the e2e test and for manual verification.

- [ ] **Step 1: Create `tools/fake-claude/fake-claude.ts`**

```typescript
#!/usr/bin/env bun
// Simulates a Claude Code session by spawning the plugin with the env vars
// Claude Code would set, then idling until killed.
//
// Usage:
//   bun tools/fake-claude/fake-claude.ts --session-id s1 --cwd /tmp/fake \
//     [--model opus-4.7] [--tmux-session work] [--socket /path/daemon.sock]

import { spawn } from "node:child_process";
import { resolve } from "node:path";

const args = parseArgs(process.argv.slice(2));
const pluginPath = resolve(import.meta.dir, "..", "..", "packages", "plugin", "src", "index.ts");

const child = spawn("bun", [pluginPath], {
  stdio: ["pipe", "inherit", "inherit"],
  env: {
    ...process.env,
    CLAUDE_SESSION_ID: args["session-id"] ?? `s_${Date.now()}`,
    CLAUDE_PROJECT_DIR: args.cwd ?? process.cwd(),
    CLAUDE_MODEL: args.model ?? "claude-sonnet-4-6",
    TMUX_SESSION: args["tmux-session"] ?? "",
    TMUX_PANE: args["tmux-pane"] ?? "",
    ...(args.socket ? { CC_REMOTE_SOCKET: args.socket } : {}),
  },
});

const shutdown = () => { child.stdin.end(); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

child.on("exit", (code) => process.exit(code ?? 0));

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const cur = argv[i]!;
    if (cur.startsWith("--")) {
      const key = cur.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) { out[key] = next; i++; } else { out[key] = "true"; }
    }
  }
  return out;
}
```

- [ ] **Step 2: Make executable**

Run: `chmod +x tools/fake-claude/fake-claude.ts`

- [ ] **Step 3: Commit**

```bash
git add tools/fake-claude/
git commit -m "tools: fake-claude harness for plugin spawning"
```

---

## Task 18: End-to-end test — session appears in PWA snapshot

**Files:**
- Create: `e2e/snapshot.test.ts`
- Create: `e2e/tsconfig.json`
- Modify: `package.json` (root) — add `e2e` to test path scope

The e2e test runs hub + daemon + plugin in the same process tree, then opens a WS client (acting as PWA) and asserts the snapshot frame contains the registered session.

- [ ] **Step 1: Create `e2e/tsconfig.json`**

```json
{
  "extends": "../tsconfig.base.json",
  "include": ["**/*.ts"]
}
```

- [ ] **Step 2: Write the e2e test**

Create `e2e/snapshot.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { HubToPwa, PwaToHub } from "@cc-remote/proto";

const ROOT = resolve(import.meta.dir, "..");
const HUB_PORT = 47745;

async function waitFor<T>(pred: () => T | null, timeoutMs: number, label: string): Promise<T> {
  const start = Date.now();
  while (true) {
    const r = pred();
    if (r) return r;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function awaitOpen(ws: WebSocket): Promise<void> {
  await new Promise<void>((res, rej) => {
    ws.addEventListener("open", () => res(), { once: true });
    ws.addEventListener("error", () => rej(new Error("ws error")), { once: true });
  });
}

test("plugin → daemon → hub → PWA snapshot loop", async () => {
  // Per-test state directory.
  const stateDir = mkdtempSync(join(tmpdir(), "ccr-e2e-"));
  writeFileSync(join(stateDir, "config.json"), JSON.stringify({
    daemon_id: "test-daemon",
    hub_url: `ws://localhost:${HUB_PORT}`,
  }));

  const procs: ChildProcess[] = [];
  const cleanup = () => {
    for (const p of procs.reverse()) try { p.kill("SIGTERM"); } catch {}
    rmSync(stateDir, { recursive: true, force: true });
  };

  try {
    // Start hub.
    const hub = spawn("bun", ["run", join(ROOT, "packages/hub/src/index.ts")], {
      env: { ...process.env, HUB_PORT: String(HUB_PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    procs.push(hub);
    await waitFor(() => hub.stdout?.readable ? true : null, 2000, "hub stdout ready");
    await new Promise((r) => setTimeout(r, 200)); // give it a tick to bind

    // Start daemon.
    const daemon = spawn("bun", ["run", join(ROOT, "packages/daemon/src/index.ts")], {
      env: { ...process.env, CC_REMOTE_STATE_DIR: stateDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    procs.push(daemon);
    await waitFor(() => daemon.stdout?.readable ? true : null, 2000, "daemon stdout ready");
    await new Promise((r) => setTimeout(r, 300));

    // Start fake-claude (which spawns plugin).
    const sockPath = join(stateDir, "daemon.sock");
    const fc = spawn("bun", [
      join(ROOT, "tools/fake-claude/fake-claude.ts"),
      "--session-id", "s_e2e",
      "--cwd", "/tmp/e2e-cwd",
      "--socket", sockPath,
    ], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    procs.push(fc);

    // Connect as PWA, subscribe, await snapshot containing s_e2e.
    const ws = new WebSocket(`ws://localhost:${HUB_PORT}/ws/pwa`);
    const inbox: HubToPwa[] = [];
    ws.addEventListener("message", (ev) => {
      try { inbox.push(JSON.parse(typeof ev.data === "string" ? ev.data : "") as HubToPwa); } catch {}
    });
    await awaitOpen(ws);
    const sub: PwaToHub = { type: "subscribe" };
    ws.send(JSON.stringify(sub));

    const found = await waitFor(() => {
      for (const f of inbox) {
        if (f.type === "snapshot") {
          for (const d of f.daemons) {
            if (d.daemon_id === "test-daemon" && d.sessions.some((s) => s.session_id === "s_e2e")) {
              return d;
            }
          }
        }
        if (f.type === "session_open" && f.daemon_id === "test-daemon" && f.session.session_id === "s_e2e") {
          return f.session;
        }
      }
      return null;
    }, 5000, "session s_e2e to appear");

    expect(found).toBeTruthy();
    ws.close();

    // Tear down fake-claude → daemon should send session_close.
    fc.stdin?.end();
    await waitFor(() => fc.exitCode !== null ? true : null, 3000, "fake-claude exit");
  } finally {
    cleanup();
  }
});
```

- [ ] **Step 3: Run the e2e test**

Run from repo root: `bun test e2e/snapshot.test.ts`
Expected: 1 passing test. It may take 5–10s.

If it fails: `bun test e2e/snapshot.test.ts --verbose` and inspect daemon/hub stderr (the spawned procs route stderr to the test output by default; capture them in the test if needed).

- [ ] **Step 4: Commit**

```bash
git add e2e/
git commit -m "test(e2e): plugin->daemon->hub->PWA snapshot loop"
```

---

## Task 19: Runbook documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace `README.md`**

```markdown
# open-cc-remote

Remote control plane for local Claude Code sessions. See the
[design spec](docs/superpowers/specs/2026-05-18-open-cc-remote-design.md).

**Status:** Plan 1 (foundation + vertical slice) complete. Auth, transcript streaming,
permission relay, Web Push, and install scripts arrive in Plans 2–6.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.1
- macOS or Linux

## Quickstart (manual)

In four terminals:

```bash
# 1. Install workspace deps
bun install

# 2. Run the hub (terminal A)
bun run packages/hub/src/index.ts
# → hub listening on http://localhost:7745

# 3. Configure & run a daemon (terminal B)
mkdir -p ~/.cc-remote
echo '{"daemon_id":"local","hub_url":"ws://localhost:7745"}' > ~/.cc-remote/config.json
bun run packages/daemon/src/index.ts
# → daemon local ready; ...

# 4. Run a fake Claude Code session (terminal C)
bun tools/fake-claude/fake-claude.ts --session-id demo --cwd "$PWD"

# 5. Open the PWA (terminal D)
bun run --filter=@cc-remote/pwa dev
# → open http://localhost:5173
```

You should see one daemon ("local") with one session ("demo"). Killing the
fake-claude process removes the row.

## Repo layout

| Package | Purpose |
| --- | --- |
| `packages/proto` | Wire frame TS types and length-prefixed JSON codec |
| `packages/plugin` | Claude Code channel plugin (MCP stdio) |
| `packages/daemon` | Long-running local process; aggregates plugins, talks to hub |
| `packages/hub` | VPS service: routes daemon ↔ PWA |
| `packages/pwa` | React/Vite browser client |
| `tools/fake-claude` | Test harness that spawns the plugin |
| `e2e/` | End-to-end tests |

## Tests

```bash
bun test               # all unit + e2e tests
bun test packages/    # unit tests only
bun test e2e/         # end-to-end only
```

## What Plan 1 does NOT cover

- Authentication (no IAS, no DPoP — anyone can connect to the hub)
- Real Claude Code conversation streaming (sessions show up but transcript is empty)
- Permission relay
- Persistence (no SQLite yet)
- Web Push
- File uploads
- `cc-remote install` / launchd / systemd units

These come in Plans 2–6.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: Plan 1 quickstart runbook"
```

---

## Task 20: Final verification — full test sweep

- [ ] **Step 1: Run typecheck across all packages**

Run from root: `bun run typecheck`
Expected: every package reports no TS errors.

- [ ] **Step 2: Run all tests**

Run: `bun test`
Expected: All proto, daemon, hub, plugin, and e2e tests pass.

- [ ] **Step 3: Manual smoke test (optional but recommended)**

Follow the README quickstart end-to-end. Verify the session row appears in the PWA at `http://localhost:5173` within ~2s of starting fake-claude. Stop fake-claude (Ctrl-C); the row disappears.

- [ ] **Step 4: Tag the milestone**

```bash
git tag plan-01-foundation
```

Plan 1 done. Hand off to Plan 2 (auth) afterward.

---

## Self-Review

**Spec coverage** (against `2026-05-18-open-cc-remote-design.md`):

| Spec section | Plan 1 coverage | Notes |
| --- | --- | --- |
| §3 Architecture overview | ✅ Tasks 1, 11 wire the four-component topology |
| §4.1 Plugin component | ⚠ partial — registers/byes only; MCP tools (reply/ack/edit_last) deferred to Plan 3 |
| §4.2 Daemon component | ⚠ partial — in-memory registry + WSS client + Unix socket; no JSONL watcher (Plan 3), no SQLite (Plan 3+), no DPoP (Plan 2) |
| §4.3 Hub component | ⚠ partial — routing only; no IAS, no persistence, no Web Push, no DPoP verify |
| §4.4 PWA component | ⚠ partial — session list only; no transcript, no notifications, no devices page |
| §5 cc-remote launcher | ❌ deferred to Plan 6 (install/CLI) |
| §6 Authentication | ❌ deferred to Plan 2 (entire chapter) |
| §7 Wire protocol | ⚠ subset implemented — Plan 1 frames only (hello/snapshot/session_*); permission/event/history frames in Plans 3–4 |
| §8 Persistence | ❌ deferred to Plan 3 |
| §9 Failure handling | ⚠ daemon↔hub reconnect implemented (§9.2); rest deferred |
| §10 Testing strategy | ⚠ partial — proto codec, hub router, daemon registry/socket/hub-client tested; e2e #1 implemented as Task 18; e2e #2/#3/#4 deferred |
| §10.5 Acceptance criteria | ❌ all deferred to Plan 6; Plan 1 has its own milestone gate (Task 20) |

The deferrals are intentional and listed up front in the plan header. No spec requirement is silently dropped.

**Placeholder scan**: Searched for "TBD", "TODO", "implement later", "appropriate error handling". The only matches are:
- Task 11 has a comment "Plan 1 simplification: rely on explicit `bye`. Plan 2 adds per-connection session tracking…" — this is an explicit deferral with a forward pointer, not a placeholder.
- Task 6 routes.ts has "Plan 1: heartbeat ignored" — same shape; explicit deferral.
- Task 7 has "Real wiring in Tasks 8–10." — forward reference within this plan, not a placeholder.

These are acceptable; they're documenting the slice boundary, not hiding work.

**Type consistency check**:
- `SessionSnapshot` shape: `tmux_session: string | null`, `tmux_pane: string | null`. Used consistently in Tasks 2, 5, 8, 9, 11, 13, 17, 18.
- `DaemonView` (hub→PWA) defined in Task 2; used in Task 5 and Task 16.
- `PluginToDaemon` register payload: `{ type: "register", session: SessionSnapshot }`. Same shape used in Tasks 9, 12, 13, 17.
- `DaemonToHub` `session_open`: `{ type, session: SessionSnapshot }` — Task 11 emits this; Task 5 router consumes the same shape; Task 18 e2e expects the same.
- `HubToPwa` `session_open` (note: different from `DaemonToHub` `session_open`): `{ type, daemon_id, session }` — Task 5 emits, Task 15 consumes. Names match across boundary.
- The `DaemonClient.send` return type is `DaemonToPlugin` — the only ack frame shape is `{ type: "ack", ref: "register" | "bye" }`. Tasks 9, 12 produce/consume the same.

No mismatches found.

**Granularity audit**: 20 tasks, average 5–8 steps each, every code-introducing step has its full code listed. No "similar to Task N" cross-references; each task can be picked up independently.
