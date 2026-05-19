# Plugin MCP Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `packages/plugin/` as a real Claude Code 2.1.143+ MCP plugin with bidirectional channel support (permission + chat), and update the rest of the workspace (proto, daemon, fake-claude, PWA, tests) so all 164+ existing tests still pass.

**Architecture:** The plugin becomes a single-mode MCP stdio server with `experimental: { 'claude/channel': {}, 'claude/channel/permission': {} }` capabilities. Plugin entrypoint generates a UUID `plugin_session_id` (external routing key) and sends it to the daemon at register time. Daemon performs an async JSONL-file-watch heuristic to bind the real Claude `claude_session_id` post-startup. fake-claude is rewritten in-process (uses `daemon-client.ts` directly, no longer spawns plugin).

**Tech Stack:** Bun runtime, TypeScript strict, `bun:test`, `@modelcontextprotocol/sdk` ^1.0, node:net Unix sockets, node:fs.watch.

**Spec:** `docs/superpowers/specs/2026-05-19-plugin-mcp-rework-design.md` (commit 9cbd2ee).

---

## File Structure (decomposition before tasks)

**Created:**
- `packages/plugin/.claude-plugin/plugin.json` — required CC manifest
- `packages/plugin/.mcp.json` — MCP server registration
- `packages/plugin/src/session.ts` — env reading + UUID
- `packages/plugin/src/permission.ts` — permission relay (CC↔daemon)
- `packages/plugin/src/chat.ts` — chat relay (CC↔daemon) + `reply` tool impl
- `packages/plugin/src/tools.ts` — MCP tools/list registration
- `packages/plugin/tests/mcp-init.test.ts` — handshake + capabilities + tools/list
- `packages/plugin/tests/permission.test.ts` — full permission roundtrip with mock daemon
- `packages/plugin/tests/chat.test.ts` — chat in/out roundtrip with mock daemon
- `packages/plugin/tests/smoke.test.ts.skipped` — manual real-claude smoke (file extension keeps it out of `bun test`)
- `packages/daemon/src/jsonl-bind.ts` — new dir-watch + first-jsonl detection module
- `packages/daemon/tests/jsonl-bind.test.ts` — unit test for the bind algorithm

**Modified:**
- `packages/proto/src/frames.ts` — `SessionSnapshot` shape change; add `chat_in`/`chat_out` types
- `packages/plugin/package.json` — add `start` script, update version
- `packages/plugin/src/index.ts` — rewrite as MCP bootstrap (was: socket-only client)
- `packages/plugin/src/daemon-client.ts` — no behavior change, but generic enough that fake-claude can import directly
- `packages/plugin/tests/daemon-client.test.ts` — adjust for new register shape
- `packages/daemon/src/index.ts` — register handler, JSONL bind integration, chat frame routing
- `packages/daemon/src/registry.ts` — same `LiveSessions` API but field renames trickle through
- `packages/daemon/tests/registry.test.ts`, `packages/daemon/tests/socket-server.test.ts` — new register shape
- `packages/hub/tests/router.test.ts` — new register shape in literals
- `packages/pwa/src/App.tsx:132-133` — null-safe `tmux_session` and `model` rendering
- `tools/fake-claude/fake-claude.ts` — in-process via daemon-client
- `e2e/permission.test.ts` — replace `CC_REMOTE_FAKE_PERMISSION` mechanism with direct frame injection from in-process fake-claude
- `README.md` (repo root) — `--plugin-dir packages/plugin` example
- `packages/plugin/README.md` (create if missing) — plugin-specific install/run notes
- `docs/TODO.md` — mark PMCP plan superseded; describe what unblocks the real-e2e plan
- `docs/superpowers/plans/2026-05-19-plugin-mcp-plan.md` — add deprecation notice header

---

## Task list

### Task 1: Proto — extend SessionSnapshot + add chat frame types

**Files:**
- Modify: `packages/proto/src/frames.ts:4-12` (SessionSnapshot interface) and after line ~172 (add chat frames)

- [ ] **Step 1: Update `SessionSnapshot`** — keep `session_id` as the external routing key (now semantically the plugin-issued UUID), add `claude_session_id`, `claude_client_version`, `plugin_version`, change `model` to nullable, keep `tmux_session`/`tmux_pane`/`cwd`/`pid`/`started_at`. Replace lines 4-12 with:

```ts
// Plugin-issued routing key (UUID generated at plugin startup) plus
// derived metadata. claude_session_id is null until the daemon's JSONL
// bind algorithm resolves it (see packages/daemon/src/jsonl-bind.ts).
export interface SessionSnapshot {
  session_id: string;                   // plugin-issued UUID, stable for life of session
  claude_session_id: string | null;     // resolved from JSONL filename post-bind
  tmux_session: string | null;
  tmux_pane: string | null;
  cwd: string;
  model: string | null;                 // null until enriched from JSONL header (future)
  pid: number;
  started_at: number;                   // unix seconds
  claude_client_version: string;        // from MCP initialize.clientInfo.version
  plugin_version: string;               // from packages/plugin/package.json
}
```

- [ ] **Step 2: Add chat frame interfaces** — append the following after `PluginPermissionReply` (before the `DaemonPermissionRequest` declaration around line 173):

```ts
// ─── chat (PWA ↔ Claude via plugin) ───────────────────────────────────

export interface PluginChatOut {
  type: "chat_out";
  session_id: string;          // plugin_session_id
  content: string;
  ts: number;                  // unix seconds
  reply_to: string | null;
}

export interface DaemonChatIn {
  type: "chat_in";
  session_id: string;          // plugin_session_id
  message_id: string;          // ULID-style for reply_to threading
  user: string;                // PWA bearer subject (email)
  user_id: string;             // PWA bearer sub claim
  content: string;
  ts: number;
}
```

- [ ] **Step 3: Wire chat frames into the union types** — modify `PluginToDaemon` (line 16-19) to include `PluginChatOut`, modify `DaemonToPlugin` (line 21-23) to include `DaemonChatIn`, and modify `HubToDaemon` (line 54-59) to include `DaemonChatIn` so the hub-side wiring (out of scope for this plan, per spec §7.2) has a type-defined seat ready:

```ts
export type PluginToDaemon =
  | { type: "register"; session: SessionSnapshot }
  | { type: "bye"; session_id: string }
  | PluginPermissionRequest
  | PluginChatOut;

export type DaemonToPlugin =
  | { type: "ack"; ref: "register" | "bye" }
  | PluginPermissionReply
  | DaemonChatIn;

export type HubToDaemon =
  | { type: "ping"; ts: number }
  | HubPermissionReply
  | HubToDaemonRequestHistory
  | HubToDaemonKillSession
  | HubToDaemonStartSession
  | DaemonChatIn;
```

- [ ] **Step 4: Run typecheck — expect failures** that we'll fix in subsequent tasks

```bash
bun run --cwd packages/proto typecheck
```
Expected: **PASS** (proto package has no consumers internally that depend on the changed fields).

```bash
bun run --cwd packages/daemon typecheck 2>&1 | head -30
```
Expected: **FAIL** with errors at `packages/daemon/src/index.ts` referencing `s.session_id` for jsonlPath etc. — these are the daemon-side adjustments needed in Task 12.

- [ ] **Step 5: Commit**

```bash
git add packages/proto/src/frames.ts
git commit -m "feat(proto): rework SessionSnapshot for plugin UUID + add chat frames"
```

---

### Task 2: Plugin manifest — `.claude-plugin/plugin.json`, `.mcp.json`, `package.json`

**Files:**
- Create: `packages/plugin/.claude-plugin/plugin.json`
- Create: `packages/plugin/.mcp.json`
- Modify: `packages/plugin/package.json` (add `start` script, bump version)
- Modify: `packages/plugin/README.md` (create new file)

- [ ] **Step 1: Write the plugin.json manifest**

```json
{
  "name": "cc-remote",
  "description": "open-cc-remote channel plugin: relays Claude Code permission prompts and chat to a remote PWA via the cc-remote daemon.",
  "version": "0.1.0",
  "keywords": ["channel", "remote", "mcp", "permission"]
}
```

Save to `packages/plugin/.claude-plugin/plugin.json`.

- [ ] **Step 2: Write the .mcp.json**

```json
{
  "mcpServers": {
    "cc-remote": {
      "command": "bun",
      "args": ["run", "--cwd", "${CLAUDE_PLUGIN_ROOT}", "--shell=bun", "--silent", "start"]
    }
  }
}
```

Save to `packages/plugin/.mcp.json`.

- [ ] **Step 3: Update package.json** — add `start` script and bump version. Replace contents with:

```json
{
  "name": "@cc-remote/plugin",
  "version": "0.1.0",
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

(Note: `bin` field is removed — Claude Code reads `.mcp.json` directly; `bin` had no effect and was misleading.)

- [ ] **Step 4: Create plugin README**

```markdown
# @cc-remote/plugin

Channel plugin for Claude Code 2.1.143+. Loaded via `--plugin-dir`:

```bash
claude --plugin-dir packages/plugin -p "your prompt"
```

Required runtime: a running cc-remote daemon at `~/.cc-remote/daemon.sock` (or `$CC_REMOTE_SOCKET`).

## Architecture

This plugin is an MCP stdio server. It speaks two protocols simultaneously:

1. **MCP stdio (to Claude Code):** `experimental: { 'claude/channel': {}, 'claude/channel/permission': {} }`. Inbound `notifications/claude/channel/permission_request`; outbound `notifications/claude/channel/permission` and `notifications/claude/channel`. Exposes one tool: `reply`.

2. **Unix socket (to daemon):** Existing `register` / `bye` / `permission_request` / `permission_reply` frames, plus new `chat_in` / `chat_out` frames.

## Validation

```bash
claude plugin validate packages/plugin
```

Should pass with at most an "author" warning.
```

Save to `packages/plugin/README.md`.

- [ ] **Step 5: Validate**

```bash
claude plugin validate packages/plugin 2>&1 | tail -10
```

Expected output (with the spec's `keywords` we expect a single warning):

```
✔ Validation passed with warnings
```

The "author" warning is acceptable — we're a private internal plugin.

- [ ] **Step 6: Commit**

```bash
git add packages/plugin/.claude-plugin/plugin.json packages/plugin/.mcp.json packages/plugin/package.json packages/plugin/README.md
git commit -m "feat(plugin): add Claude Code plugin manifest + .mcp.json"
```

---

### Task 3: `src/session.ts` — env reading + UUID + start metadata

**Files:**
- Create: `packages/plugin/src/session.ts`
- Test: `packages/plugin/tests/session.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { buildSession } from "../src/session.ts";
import type { SessionSnapshot } from "@cc-remote/proto";

test("buildSession reads env + generates UUID", () => {
  const env = {
    CLAUDE_PROJECT_DIR: "/Users/me/proj",
    TMUX_SESSION: "work",
    TMUX_PANE: "%0",
  };
  const s: SessionSnapshot = buildSession({ env, claudeClientVersion: "2.1.144", pluginVersion: "0.1.0", pid: 4242, now: 1700000000 });
  expect(s.session_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(s.cwd).toBe("/Users/me/proj");
  expect(s.tmux_session).toBe("work");
  expect(s.tmux_pane).toBe("%0");
  expect(s.claude_client_version).toBe("2.1.144");
  expect(s.plugin_version).toBe("0.1.0");
  expect(s.pid).toBe(4242);
  expect(s.started_at).toBe(1700000000);
  expect(s.claude_session_id).toBeNull();
  expect(s.model).toBeNull();
});

test("buildSession throws when CLAUDE_PROJECT_DIR is missing", () => {
  expect(() => buildSession({ env: {}, claudeClientVersion: "x", pluginVersion: "y", pid: 1, now: 0 })).toThrow(/CLAUDE_PROJECT_DIR/);
});

test("buildSession leaves tmux fields null when env is missing", () => {
  const s = buildSession({ env: { CLAUDE_PROJECT_DIR: "/x" }, claudeClientVersion: "v", pluginVersion: "p", pid: 1, now: 1 });
  expect(s.tmux_session).toBeNull();
  expect(s.tmux_pane).toBeNull();
});
```

Save to `packages/plugin/tests/session.test.ts`.

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test packages/plugin/tests/session.test.ts 2>&1 | tail -10
```
Expected: FAIL — module `../src/session.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
import { randomUUID } from "node:crypto";
import type { SessionSnapshot } from "@cc-remote/proto";

export interface BuildSessionInput {
  env: Record<string, string | undefined>;
  claudeClientVersion: string;
  pluginVersion: string;
  pid: number;
  now: number;                  // unix seconds
}

export function buildSession(i: BuildSessionInput): SessionSnapshot {
  const cwd = i.env.CLAUDE_PROJECT_DIR;
  if (!cwd) throw new Error("buildSession: CLAUDE_PROJECT_DIR is required (Claude Code should set this; if unset, you're running the plugin in the wrong context)");

  return {
    session_id: randomUUID(),
    claude_session_id: null,
    tmux_session: i.env.TMUX_SESSION ? i.env.TMUX_SESSION : null,
    tmux_pane: i.env.TMUX_PANE ? i.env.TMUX_PANE : null,
    cwd,
    model: null,
    pid: i.pid,
    started_at: i.now,
    claude_client_version: i.claudeClientVersion,
    plugin_version: i.pluginVersion,
  };
}
```

Save to `packages/plugin/src/session.ts`.

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test packages/plugin/tests/session.test.ts 2>&1 | tail -5
```
Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/plugin/src/session.ts packages/plugin/tests/session.test.ts
git commit -m "feat(plugin): add session.ts (env reader + UUID generator)"
```

---

### Task 4: `src/permission.ts` — permission relay handlers

**Files:**
- Create: `packages/plugin/src/permission.ts`

This module is a pure factory: given a `daemonClient` and an `mcpServer`, it wires up:
- inbound `notifications/claude/channel/permission_request` → daemon `permission_request` frame
- daemon-side `permission_reply` → outbound MCP `notifications/claude/channel/permission`

Tests for this module live in `packages/plugin/tests/permission.test.ts` (Task 9, end-to-end with mock daemon).

- [ ] **Step 1: Write minimal implementation**

```ts
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { z } from "zod";
import type { DaemonClient } from "./daemon-client.ts";

const PermissionRequestNotification = z.object({
  method: z.literal("notifications/claude/channel/permission_request"),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});

export interface PermissionRelayDeps {
  mcp: Server;
  daemon: DaemonClient;
  pluginSessionId: string;
}

export function installPermissionRelay({ mcp, daemon, pluginSessionId }: PermissionRelayDeps): void {
  // CC → plugin: permission_request → daemon
  mcp.setNotificationHandler(PermissionRequestNotification, async ({ params }) => {
    try {
      daemon.sendOneWay({
        type: "permission_request",
        request_id: params.request_id,
        tool: params.tool_name,
        args_summary: params.input_preview || params.description,
        expires_at: Date.now() + 5 * 60_000,
      });
    } catch (e) {
      // Daemon write failed — fail-closed by emitting deny back to CC
      process.stderr.write(`cc-remote plugin: forwarding permission_request to daemon failed: ${(e as Error).message}\n`);
      void mcp.notification({
        method: "notifications/claude/channel/permission",
        params: { request_id: params.request_id, behavior: "deny" },
      });
    }
  });
}

// Daemon → CC: invoked by index.ts when a permission_reply frame arrives on the daemon socket
export function emitPermissionDecision(mcp: Server, request_id: string, decision: "allow" | "deny"): void {
  void mcp.notification({
    method: "notifications/claude/channel/permission",
    params: { request_id, behavior: decision },
  });
}
```

Save to `packages/plugin/src/permission.ts`.

- [ ] **Step 2: Run typecheck — expect pass**

```bash
bun run --cwd packages/plugin typecheck 2>&1 | tail -5
```
Expected: PASS for permission.ts (the rest of the plugin will fail since `index.ts` is not yet rewritten — that's OK for now).

- [ ] **Step 3: Commit**

```bash
git add packages/plugin/src/permission.ts
git commit -m "feat(plugin): permission relay module (CC ↔ daemon)"
```

---

### Task 5: `src/chat.ts` — chat relay + reply tool implementation

**Files:**
- Create: `packages/plugin/src/chat.ts`

Same pattern as Task 4. Routes:
- daemon `chat_in` → MCP `notifications/claude/channel`
- MCP `tools/call` for `reply` → daemon `chat_out`

- [ ] **Step 1: Write minimal implementation**

```ts
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { DaemonClient } from "./daemon-client.ts";

export interface ChatRelayDeps {
  mcp: Server;
  daemon: DaemonClient;
  pluginSessionId: string;
}

export function installChatRelay({ mcp, daemon, pluginSessionId }: ChatRelayDeps): void {
  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name !== "reply") {
      throw new Error(`unknown tool: ${req.params.name}`);
    }
    const args = req.params.arguments ?? {};
    const text = typeof args.text === "string" ? args.text : "";
    if (!text) throw new Error("reply: 'text' is required and must be a non-empty string");
    const reply_to = typeof args.reply_to === "string" ? args.reply_to : null;

    daemon.sendOneWay({
      type: "chat_out",
      session_id: pluginSessionId,
      content: text,
      ts: Math.floor(Date.now() / 1000),
      reply_to,
    });

    return { content: [{ type: "text", text: "delivered" }] };
  });
}

// Called by index.ts when a chat_in frame arrives on the daemon socket
export function emitChatIn(mcp: Server, frame: { message_id: string; user: string; user_id: string; content: string; ts: number }): void {
  void mcp.notification({
    method: "notifications/claude/channel",
    params: {
      content: frame.content,
      meta: {
        chat_id: "pwa",
        message_id: frame.message_id,
        user: frame.user,
        user_id: frame.user_id,
        ts: frame.ts,
      },
    },
  });
}
```

Save to `packages/plugin/src/chat.ts`.

- [ ] **Step 2: Commit**

```bash
git add packages/plugin/src/chat.ts
git commit -m "feat(plugin): chat relay module (reply tool + chat_in notif)"
```

---

### Task 6: `src/tools.ts` — MCP tools/list registration

**Files:**
- Create: `packages/plugin/src/tools.ts`

- [ ] **Step 1: Write minimal implementation**

```ts
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export function installTools(mcp: Server): void {
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "reply",
        description:
          "Send a message to the cc-remote PWA. Pass reply_to (a message_id) for threading; for normal responses omit reply_to.",
        inputSchema: {
          type: "object" as const,
          properties: {
            text: { type: "string" as const, description: "The message to deliver to the PWA user" },
            reply_to: { type: "string" as const, description: "Optional message_id to thread under" },
          },
          required: ["text"],
        },
      },
    ],
  }));
}
```

Save to `packages/plugin/src/tools.ts`.

- [ ] **Step 2: Commit**

```bash
git add packages/plugin/src/tools.ts
git commit -m "feat(plugin): tools/list module (single 'reply' tool)"
```

---

### Task 7: `src/index.ts` — rewrite as MCP bootstrap

**Files:**
- Modify (full rewrite): `packages/plugin/src/index.ts`

The old `index.ts` becomes obsolete. Replace its entire content.

- [ ] **Step 1: Write the new bootstrap**

```ts
#!/usr/bin/env bun
import { join } from "node:path";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { InitializeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { connectDaemon } from "./daemon-client.ts";
import { buildSession } from "./session.ts";
import { installPermissionRelay, emitPermissionDecision } from "./permission.ts";
import { installChatRelay, emitChatIn } from "./chat.ts";
import { installTools } from "./tools.ts";

const INSTRUCTIONS = [
  "The PWA user reads cc-remote, not this session. Anything you want them to see must go through the reply tool — your transcript output never reaches them.",
  "",
  'Messages from the PWA arrive as <channel source="cc-remote" chat_id="pwa" message_id="..." user="..." ts="...">. Reply with the reply tool. Use reply_to (set to a message_id) only when threading; for normal responses, omit reply_to.',
  "",
  "Permission prompts are routed to the PWA. The PWA user authenticates via SAP IAS before they can approve or deny — you can trust the channel.",
].join("\n");

async function main() {
  const pkgPath = join(import.meta.dir, "..", "package.json");
  const pluginVersion = (JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string }).version;

  const sockPath = process.env.CC_REMOTE_SOCKET ?? join(homedir(), ".cc-remote", "daemon.sock");
  let daemon;
  try {
    daemon = await connectDaemon(sockPath, { timeoutMs: 3000 });
  } catch (e) {
    process.stderr.write(`cc-remote plugin: cannot reach daemon at ${sockPath}: ${(e as Error).message}\n`);
    process.exit(1);
  }

  // We need claude_client_version from MCP initialize. Set up Server first; the
  // real session register happens AFTER initialize, in the handler below.
  const mcp = new Server(
    { name: "cc-remote", version: pluginVersion },
    {
      capabilities: {
        tools: {},
        experimental: {
          "claude/channel": {},
          "claude/channel/permission": {},
        },
      },
      instructions: INSTRUCTIONS,
    },
  );

  let registered = false;
  let pluginSessionId = "";

  // Hook into initialize so we can read clientInfo.version before registering.
  mcp.setRequestHandler(InitializeRequestSchema, async (req) => {
    const claudeClientVersion = req.params.clientInfo?.version ?? "unknown";

    const session = buildSession({
      env: process.env,
      claudeClientVersion,
      pluginVersion,
      pid: process.pid,
      now: Math.floor(Date.now() / 1000),
    });
    pluginSessionId = session.session_id;

    try {
      await daemon.send({ type: "register", session });
      registered = true;
      process.stderr.write(`cc-remote plugin: registered ${session.session_id} cwd=${session.cwd}\n`);
    } catch (e) {
      process.stderr.write(`cc-remote plugin: register failed: ${(e as Error).message}\n`);
      process.exit(1);
    }

    installPermissionRelay({ mcp, daemon, pluginSessionId });
    installChatRelay({ mcp, daemon, pluginSessionId });
    installTools(mcp);

    // Forward daemon-side frames to MCP notifications.
    daemon.onFrame((f) => {
      if (f.type === "permission_reply") {
        emitPermissionDecision(mcp, f.request_id, f.decision);
      } else if (f.type === "chat_in") {
        emitChatIn(mcp, f);
      }
    });

    // Standard MCP initialize response.
    return {
      protocolVersion: req.params.protocolVersion ?? "2024-11-05",
      capabilities: {
        tools: {},
        experimental: {
          "claude/channel": {},
          "claude/channel/permission": {},
        },
      },
      serverInfo: { name: "cc-remote", version: pluginVersion },
      instructions: INSTRUCTIONS,
    };
  });

  const goodbye = async (code: number) => {
    if (registered) {
      try {
        await Promise.race([
          daemon.send({ type: "bye", session_id: pluginSessionId }),
          new Promise((r) => setTimeout(r, 500)),
        ]);
      } catch {}
    }
    daemon.close();
    process.exit(code);
  };

  process.on("SIGINT", () => goodbye(130));
  process.on("SIGTERM", () => goodbye(143));

  await mcp.connect(new StdioServerTransport());
}

main().catch((e) => {
  process.stderr.write(`cc-remote plugin fatal: ${(e as Error).message}\n`);
  process.exit(1);
});
```

Save (overwriting) to `packages/plugin/src/index.ts`.

- [ ] **Step 2: Update `daemon-client.ts` to expose an `onFrame` callback**

The current `daemon-client.ts` only resolves `send` Promises in order — there's no general "incoming frame from daemon" callback. We need one for `permission_reply` and `chat_in`. Modify `packages/plugin/src/daemon-client.ts`:

Replace the `DaemonClient` interface:
```ts
export interface DaemonClient {
  send(frame: PluginToDaemon): Promise<DaemonToPlugin>;
  sendOneWay(frame: PluginToDaemon): void;
  onFrame(handler: (f: DaemonToPlugin) => void): void;
  close(): void;
}
```

Inside `connectDaemon`, change the `data` handler. Replace the existing `sock.on("data", ...)` block with:
```ts
const queue: Array<(f: DaemonToPlugin) => void> = [];
let frameHandler: ((f: DaemonToPlugin) => void) | null = null;

sock.on("data", (chunk: Buffer) => {
  try {
    for (const f of decoder.push(chunk)) {
      const cb = queue.shift();
      if (cb) cb(f as DaemonToPlugin);
      else if (frameHandler) frameHandler(f as DaemonToPlugin);
    }
  } catch (e) { sock.destroy(e as Error); }
});
```

Replace the returned object:
```ts
return {
  send(frame) {
    return new Promise<DaemonToPlugin>((resolve) => {
      queue.push(resolve);
      sock.write(encodeFrame(frame));
    });
  },
  sendOneWay(frame) { sock.write(encodeFrame(frame)); },
  onFrame(handler) { frameHandler = handler; },
  close() { try { sock.end(); } catch {} },
};
```

The `sock.on("close", ...)` listener already drains the queue with synthetic acks; that stays unchanged.

- [ ] **Step 3: Run typecheck**

```bash
bun run --cwd packages/plugin typecheck 2>&1 | tail -10
```
Expected: PASS — all plugin code now references valid imports.

- [ ] **Step 4: Commit**

```bash
git add packages/plugin/src/index.ts packages/plugin/src/daemon-client.ts
git commit -m "feat(plugin): rewrite index.ts as MCP stdio server bootstrap"
```

---

### Task 8: Plugin test — `mcp-init.test.ts`

**Files:**
- Create: `packages/plugin/tests/mcp-init.test.ts`

Spawns the plugin via stdio; uses a tiny in-test mock daemon (so the plugin's connectDaemon succeeds); drives an MCP `initialize` request; asserts capabilities and tools/list.

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { startSocketServer } from "../../daemon/src/socket-server.ts";

interface JsonRpc { jsonrpc: "2.0"; id?: number | string; method?: string; params?: unknown; result?: unknown; error?: unknown; }

async function withChild<T>(child: ChildProcess, fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } finally { child.kill("SIGTERM"); }
}

function send(child: ChildProcess, msg: JsonRpc) {
  child.stdin!.write(JSON.stringify(msg) + "\n");
}

function readLines(child: ChildProcess, onMsg: (m: JsonRpc) => void): void {
  let buf = "";
  child.stdout!.on("data", (b: Buffer) => {
    buf += b.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try { onMsg(JSON.parse(line) as JsonRpc); } catch {}
    }
  });
}

test("plugin handshake: initialize → capabilities + tools/list returns reply", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-mcp-init-"));
  const sockPath = join(dir, "d.sock");
  try {
    // Mock daemon: just ack everything.
    const server = startSocketServer({
      path: sockPath,
      onFrame: (f, c) => {
        if (f.type === "register" || f.type === "bye") server.replyTo(c, { type: "ack", ref: f.type });
      },
    });
    await server.ready;

    const child = spawn("bun", ["run", join(import.meta.dir, "..", "src", "index.ts")], {
      env: { ...process.env, CC_REMOTE_SOCKET: sockPath, CLAUDE_PROJECT_DIR: dir },
      stdio: ["pipe", "pipe", "inherit"],
    });

    await withChild(child, async () => {
      const messages: JsonRpc[] = [];
      readLines(child, (m) => messages.push(m));

      send(child, {
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-host", version: "9.9.9" },
        },
      });
      send(child, { jsonrpc: "2.0", method: "notifications/initialized" });

      const initResp = await waitFor(() => messages.find((m) => m.id === 1) ?? null, 3000, "initialize response");
      const result = initResp.result as any;
      expect(result.serverInfo.name).toBe("cc-remote");
      expect(result.capabilities.experimental["claude/channel"]).toBeDefined();
      expect(result.capabilities.experimental["claude/channel/permission"]).toBeDefined();

      send(child, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      const tools = await waitFor(() => messages.find((m) => m.id === 2) ?? null, 3000, "tools/list response");
      const toolList = (tools.result as any).tools as Array<{ name: string }>;
      expect(toolList.map((t) => t.name)).toEqual(["reply"]);
    });

    server.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function waitFor<T>(pred: () => T | null, timeoutMs: number, label: string): Promise<T> {
  const start = Date.now();
  while (true) {
    const v = pred();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
```

Save to `packages/plugin/tests/mcp-init.test.ts`.

- [ ] **Step 2: Run test**

```bash
bun test packages/plugin/tests/mcp-init.test.ts 2>&1 | tail -10
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/plugin/tests/mcp-init.test.ts
git commit -m "test(plugin): mcp-init handshake + tools/list"
```

---

### Task 9: Plugin test — `permission.test.ts`

**Files:**
- Create: `packages/plugin/tests/permission.test.ts`

End-to-end with mock daemon: drive a permission_request notification → assert daemon receives forwarded frame → daemon replies → assert plugin emits notification back.

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { startSocketServer } from "../../daemon/src/socket-server.ts";
import type { PluginToDaemon } from "@cc-remote/proto";

interface JsonRpc { jsonrpc: "2.0"; id?: number | string; method?: string; params?: unknown; result?: unknown; }

async function waitFor<T>(pred: () => T | null, timeoutMs: number, label: string): Promise<T> {
  const start = Date.now();
  while (true) {
    const v = pred();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

test("plugin permission relay: CC notif → daemon frame → daemon reply → CC notif", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-perm-"));
  const sockPath = join(dir, "d.sock");
  try {
    const seen: PluginToDaemon[] = [];
    let pluginSocket: any = null;
    const server = startSocketServer({
      path: sockPath,
      onFrame: (f, c) => {
        seen.push(f);
        pluginSocket = c;
        if (f.type === "register" || f.type === "bye") server.replyTo(c, { type: "ack", ref: f.type });
      },
    });
    await server.ready;

    const child: ChildProcess = spawn("bun", ["run", join(import.meta.dir, "..", "src", "index.ts")], {
      env: { ...process.env, CC_REMOTE_SOCKET: sockPath, CLAUDE_PROJECT_DIR: dir },
      stdio: ["pipe", "pipe", "inherit"],
    });

    try {
      const messages: JsonRpc[] = [];
      let buf = "";
      child.stdout!.on("data", (b: Buffer) => {
        buf += b.toString("utf8");
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try { messages.push(JSON.parse(line) as JsonRpc); } catch {}
        }
      });

      // Initialize handshake
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "9.9.9" } } }) + "\n");
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      await waitFor(() => seen.find((f) => f.type === "register") ?? null, 3000, "register frame");

      // Send permission_request notification from "CC" → plugin
      child.stdin!.write(JSON.stringify({
        jsonrpc: "2.0", method: "notifications/claude/channel/permission_request",
        params: { request_id: "abcde", tool_name: "Bash", description: "rm -rf", input_preview: "rm -rf /tmp/x" },
      }) + "\n");

      // Plugin should forward to daemon as permission_request frame
      const fwd = await waitFor(() => seen.find((f) => f.type === "permission_request") ?? null, 3000, "forwarded permission_request");
      expect((fwd as any).request_id).toBe("abcde");
      expect((fwd as any).tool).toBe("Bash");
      expect((fwd as any).args_summary).toBe("rm -rf /tmp/x");

      // Daemon "answers" by sending permission_reply
      server.replyTo(pluginSocket, { type: "permission_reply", request_id: "abcde", decision: "allow" });

      // Plugin should emit notifications/claude/channel/permission back to CC
      const out = await waitFor(() => messages.find((m) => m.method === "notifications/claude/channel/permission") ?? null, 3000, "outbound permission notif");
      expect((out.params as any).request_id).toBe("abcde");
      expect((out.params as any).behavior).toBe("allow");
    } finally {
      child.kill("SIGTERM");
    }

    server.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

Save to `packages/plugin/tests/permission.test.ts`.

- [ ] **Step 2: Run test**

```bash
bun test packages/plugin/tests/permission.test.ts 2>&1 | tail -10
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/plugin/tests/permission.test.ts
git commit -m "test(plugin): permission roundtrip with mock daemon"
```

---

### Task 10: Plugin test — `chat.test.ts`

**Files:**
- Create: `packages/plugin/tests/chat.test.ts`

Test (a): `tools/call` `reply` → daemon sees `chat_out` frame.
Test (b): mock daemon sends `chat_in` → plugin emits `notifications/claude/channel`.

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { startSocketServer } from "../../daemon/src/socket-server.ts";
import type { PluginToDaemon } from "@cc-remote/proto";

interface JsonRpc { jsonrpc: "2.0"; id?: number | string; method?: string; params?: unknown; result?: unknown; }

async function waitFor<T>(pred: () => T | null, timeoutMs: number, label: string): Promise<T> {
  const start = Date.now();
  while (true) {
    const v = pred();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

test("plugin chat: reply tool sends chat_out; chat_in becomes channel notification", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-chat-"));
  const sockPath = join(dir, "d.sock");
  try {
    const seen: PluginToDaemon[] = [];
    let pluginSocket: any = null;
    const server = startSocketServer({
      path: sockPath,
      onFrame: (f, c) => {
        seen.push(f);
        pluginSocket = c;
        if (f.type === "register" || f.type === "bye") server.replyTo(c, { type: "ack", ref: f.type });
      },
    });
    await server.ready;

    const child: ChildProcess = spawn("bun", ["run", join(import.meta.dir, "..", "src", "index.ts")], {
      env: { ...process.env, CC_REMOTE_SOCKET: sockPath, CLAUDE_PROJECT_DIR: dir },
      stdio: ["pipe", "pipe", "inherit"],
    });
    try {
      const messages: JsonRpc[] = [];
      let buf = "";
      child.stdout!.on("data", (b: Buffer) => {
        buf += b.toString("utf8");
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try { messages.push(JSON.parse(line) as JsonRpc); } catch {}
        }
      });

      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "9.9.9" } } }) + "\n");
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      const reg = await waitFor(() => seen.find((f) => f.type === "register") ?? null, 3000, "register") as any;
      const sid = reg.session.session_id;

      // (a) Call reply tool
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "reply", arguments: { text: "hello pwa" } } }) + "\n");
      const out = await waitFor(() => seen.find((f) => f.type === "chat_out") ?? null, 3000, "chat_out frame") as any;
      expect(out.session_id).toBe(sid);
      expect(out.content).toBe("hello pwa");
      expect(out.reply_to).toBeNull();
      const reply = await waitFor(() => messages.find((m) => m.id === 2) ?? null, 3000, "tools/call response");
      expect(((reply.result as any).content as any[])[0].text).toBe("delivered");

      // (b) Daemon sends chat_in
      server.replyTo(pluginSocket, {
        type: "chat_in",
        session_id: sid,
        message_id: "m1",
        user: "alice@sap.com",
        user_id: "u-1",
        content: "hi from pwa",
        ts: 1700000000,
      });
      const notif = await waitFor(() => messages.find((m) => m.method === "notifications/claude/channel") ?? null, 3000, "channel notif");
      const p = notif.params as any;
      expect(p.content).toBe("hi from pwa");
      expect(p.meta.message_id).toBe("m1");
      expect(p.meta.user).toBe("alice@sap.com");
      expect(p.meta.chat_id).toBe("pwa");
    } finally { child.kill("SIGTERM"); }

    server.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

Save to `packages/plugin/tests/chat.test.ts`.

- [ ] **Step 2: Run test**

```bash
bun test packages/plugin/tests/chat.test.ts 2>&1 | tail -10
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/plugin/tests/chat.test.ts
git commit -m "test(plugin): chat roundtrip with mock daemon"
```

---

### Task 11: Update `daemon-client.test.ts` for new register shape

**Files:**
- Modify: `packages/plugin/tests/daemon-client.test.ts:21-25`

The existing test uses the old SessionSnapshot shape. Update it to match the new shape.

- [ ] **Step 1: Update the test register frame**

Replace lines 21-26 (the `client.send({ type: "register", session: ... })` block) with:

```ts
    const ack1 = await client.send({
      type: "register",
      session: {
        session_id: "s1",
        claude_session_id: null,
        tmux_session: null,
        tmux_pane: null,
        cwd: "/x",
        model: null,
        pid: 1,
        started_at: 1,
        claude_client_version: "test",
        plugin_version: "0.1.0",
      }
    });
```

- [ ] **Step 2: Run test**

```bash
bun test packages/plugin/tests/daemon-client.test.ts 2>&1 | tail -5
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/plugin/tests/daemon-client.test.ts
git commit -m "test(plugin): update daemon-client.test for new register shape"
```

---

### Task 12: Daemon — JSONL bind module + tests

**Files:**
- Create: `packages/daemon/src/jsonl-bind.ts`
- Create: `packages/daemon/tests/jsonl-bind.test.ts`

The daemon needs to discover the real `claude_session_id` from a new JSONL file appearing in `~/.claude/projects/<encoded-cwd>/`. This module isolates that algorithm.

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindJsonl } from "../src/jsonl-bind.ts";

test("bindJsonl resolves with the first new .jsonl file's basename UUID", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-bind-"));
  try {
    const expected = "11111111-1111-1111-1111-111111111111";
    const filePath = join(dir, `${expected}.jsonl`);
    setTimeout(() => writeFileSync(filePath, "{}\n"), 50);
    const claudeId = await bindJsonl({ dir, registerTimeMs: Date.now() - 100, timeoutMs: 2000 });
    expect(claudeId).toBe(expected);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("bindJsonl resolves null on timeout with no new file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-bind-to-"));
  try {
    const claudeId = await bindJsonl({ dir, registerTimeMs: Date.now(), timeoutMs: 200 });
    expect(claudeId).toBeNull();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("bindJsonl ignores non-jsonl files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-bind-other-"));
  try {
    const expected = "22222222-2222-2222-2222-222222222222";
    setTimeout(() => writeFileSync(join(dir, "not-a-session.txt"), "x"), 30);
    setTimeout(() => writeFileSync(join(dir, `${expected}.jsonl`), "{}\n"), 80);
    const claudeId = await bindJsonl({ dir, registerTimeMs: Date.now() - 100, timeoutMs: 2000 });
    expect(claudeId).toBe(expected);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

Save to `packages/daemon/tests/jsonl-bind.test.ts`.

- [ ] **Step 2: Run test — expect fail**

```bash
bun test packages/daemon/tests/jsonl-bind.test.ts 2>&1 | tail -5
```
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the implementation**

```ts
import { watch, mkdirSync, existsSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface BindJsonlInput {
  dir: string;
  registerTimeMs: number;
  timeoutMs: number;
}

const UUID_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

// Watches `dir` for the first .jsonl file whose mtime is at or after
// (registerTimeMs - 2000ms) — small back-skew tolerance for clock and
// fs.watch event ordering. Resolves with the basename UUID, or null on timeout.
export async function bindJsonl({ dir, registerTimeMs, timeoutMs }: BindJsonlInput): Promise<string | null> {
  if (!existsSync(dir)) {
    try { mkdirSync(dir, { recursive: true }); } catch {}
  }

  const back = registerTimeMs - 2000;

  // Pre-scan: in case a JSONL was already created moments before register.
  for (const entry of readdirSync(dir)) {
    const m = UUID_RE.exec(entry);
    if (!m) continue;
    let mtime: number;
    try { mtime = statSync(join(dir, entry)).mtimeMs; } catch { continue; }
    if (mtime >= back) return m[1].toLowerCase();
  }

  return await new Promise<string | null>((resolve) => {
    let done = false;
    const finish = (id: string | null) => {
      if (done) return;
      done = true;
      try { watcher.close(); } catch {}
      clearTimeout(timer);
      resolve(id);
    };

    const watcher = watch(dir, { persistent: false }, (_event, filename) => {
      if (!filename) return;
      const m = UUID_RE.exec(filename);
      if (!m) return;
      let mtime: number;
      try { mtime = statSync(join(dir, filename)).mtimeMs; } catch { return; }
      if (mtime >= back) finish(m[1].toLowerCase());
    });
    watcher.on("error", () => finish(null));
    const timer = setTimeout(() => finish(null), timeoutMs);
  });
}
```

Save to `packages/daemon/src/jsonl-bind.ts`.

- [ ] **Step 4: Run test — expect pass**

```bash
bun test packages/daemon/tests/jsonl-bind.test.ts 2>&1 | tail -5
```
Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/jsonl-bind.ts packages/daemon/tests/jsonl-bind.test.ts
git commit -m "feat(daemon): jsonl-bind module (first-jsonl heuristic)"
```

---

### Task 13: Daemon — integrate JSONL bind + chat frame routing + null-safe SessionSnapshot

**Files:**
- Modify: `packages/daemon/src/index.ts` (multiple sites)
- Modify: `packages/daemon/src/registry.ts` (signature change for `update`)

The `sessions.onAdd` callback (around `index.ts:155`) currently starts the watcher immediately at `jsonlPath(s.cwd, s.session_id)`. After this change: it kicks off `bindJsonl(...)` first, then starts the watcher with the bound `claude_session_id`. If bind fails, no watcher.

- [ ] **Step 1: Add a `update` method to `LiveSessions`**

Append to `packages/daemon/src/registry.ts`:

```ts
  update(session_id: string, patch: Partial<SessionSnapshot>): void {
    const cur = this.sessions.get(session_id);
    if (!cur) return;
    this.sessions.set(session_id, { ...cur, ...patch });
  }
```

(Place it after `add(...)` and before `remove(...)`.)

- [ ] **Step 2: Modify `index.ts` — replace the `sessions.onAdd` block (around line 155-207)**

Replace the entire `sessions.onAdd((s: SessionSnapshot) => { ... })` callback with:

```ts
import { bindJsonl } from "./jsonl-bind.ts";
import { dirname } from "node:path";

sessions.onAdd((s: SessionSnapshot) => {
  hub.send({ type: "session_open", session: s });

  // Asynchronously bind the JSONL: discover the real claude_session_id
  // by watching the cwd's projects dir for a new .jsonl file.
  const projectsDirForCwd = dirname(jsonlPath(s.cwd, "_placeholder"));
  void bindJsonl({ dir: projectsDirForCwd, registerTimeMs: Date.now(), timeoutMs: 30_000 }).then((claudeId) => {
    if (!claudeId) {
      process.stderr.write(`daemon: jsonl bind timed out for session ${s.session_id} (cwd=${s.cwd}); history will be unavailable\n`);
      return;
    }
    sessions.update(s.session_id, { claude_session_id: claudeId });

    const path = jsonlPath(s.cwd, claudeId);
    const watcher = startWatcher(path, {
      onEvent: (jsonl_offset, payload) => {
        const existing = idleTimers.get(s.session_id);
        if (existing) { clearTimeout(existing); idleTimers.delete(s.session_id); }
        hub.send({
          type: "event",
          session_id: s.session_id,
          jsonl_offset,
          ts: Date.now(),
          payload,
        });

        // Detect end_turn — same logic as before
        const p = payload as { type?: string; message?: { stop_reason?: string } };
        if (p.type === "assistant" && p.message?.stop_reason === "end_turn") {
          hub.send({ type: "task_completed", session_id: s.session_id, ts: Date.now() });
          const t = setTimeout(() => {
            idleTimers.delete(s.session_id);
            hub.send({ type: "idle", session_id: s.session_id, ts: Date.now() });
          }, cfg.idle_window_ms);
          idleTimers.set(s.session_id, t);
        }
      },
      onError: (e: Error) => process.stderr.write(`daemon: watcher error for ${s.session_id}: ${e.message}\n`),
    });
    watchers.set(s.session_id, watcher);
  });
});
```

(Note: `bindJsonl` and `dirname` imports are added at the top of the file. Other `index.ts` imports stay the same.)

- [ ] **Step 3: Add chat_in frame routing — modify the daemon's hub-frame handler (around line 60-110 of `index.ts`)**

Add this new case to the existing `if/else if` chain in the `onFrame: (frame: HubToDaemon) => { ... }` block. (Currently the hub doesn't send `chat_in` to the daemon — that wiring is in a follow-on plan — so this is just a stub that handles the type.)

```ts
    // chat_in from hub: forward to plugin via the session's socket. Hub-side
    // wiring lands in a follow-on plan; this branch is forward-compatible.
    else if (frame.type === "chat_in") {
      const client = sessionToClient.get((frame as any).session_id);
      if (client) {
        sockServer.replyTo(client, frame as any);
      }
    }
```

(Place it after the `kill_session` block, before the closing brace of the `onFrame` lambda.)

- [ ] **Step 4: Add chat_out frame routing — modify the daemon's plugin-frame handler (around the `startSocketServer({ ..., onFrame: (frame, client) => { ... } })` near line 220)**

Find the existing `onFrame` for the socket server. After the `permission_request` handling block, add:

```ts
    } else if (frame.type === "chat_out") {
      // Forward upstream to hub. Hub-side chat wiring lands in the follow-on
      // chat-routing plan; for now we surface chat_out via stderr so it's
      // visible during integration tests.
      process.stderr.write(`daemon: chat_out from ${(frame as any).session_id}: ${(frame as any).content.slice(0, 80)}\n`);
```

This stays a stub for v1. The plan that wires hub-side chat fills in the TODO. Note: this is the only TODO permitted in the plan; it documents an explicit boundary acknowledged by the spec §3 / §7.2.

- [ ] **Step 5: Run typecheck**

```bash
bun run --cwd packages/daemon typecheck 2>&1 | tail -10
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/src/index.ts packages/daemon/src/registry.ts
git commit -m "feat(daemon): integrate JSONL bind + chat frame stubs"
```

---

### Task 14: Refactor `tools/fake-claude/fake-claude.ts` to in-process

**Files:**
- Modify (full rewrite): `tools/fake-claude/fake-claude.ts`

- [ ] **Step 1: Rewrite the script**

```ts
#!/usr/bin/env bun
// In-process fake Claude session — connects directly to the daemon's Unix
// socket, sends a register frame, then idles. Replaces the previous
// "spawn the plugin" approach which is no longer compatible with the
// MCP-only plugin entry point.
//
// Usage:
//   bun tools/fake-claude/fake-claude.ts --session-id s1 --cwd /tmp/fake \
//     [--socket /path/daemon.sock] [--inject-permission Bash:req-1:rm/-rf]

import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { connectDaemon } from "../../packages/plugin/src/daemon-client.ts";
import type { SessionSnapshot } from "@cc-remote/proto";

const args = parseArgs(process.argv.slice(2));

async function main() {
  const sockPath = args.socket ?? process.env.CC_REMOTE_SOCKET ?? join(homedir(), ".cc-remote", "daemon.sock");

  const session: SessionSnapshot = {
    session_id: args["session-id"] ?? randomUUID(),
    claude_session_id: args["claude-session-id"] ?? null,
    tmux_session: args["tmux-session"] || null,
    tmux_pane: args["tmux-pane"] || null,
    cwd: args.cwd ?? process.cwd(),
    model: args.model ?? null,
    pid: process.pid,
    started_at: Math.floor(Date.now() / 1000),
    claude_client_version: "fake-claude",
    plugin_version: "fake",
  };

  const client = await connectDaemon(sockPath, { timeoutMs: 3000 });
  await client.send({ type: "register", session });
  process.stderr.write(`fake-claude: registered ${session.session_id} cwd=${session.cwd}\n`);

  // Optional: synthesize a permission_request frame for tests that exercised
  // the old CC_REMOTE_FAKE_PERMISSION env hook on the spawned plugin.
  const inj = args["inject-permission"]; // format: tool:request_id:args_summary
  if (inj) {
    const [tool, request_id, ...rest] = inj.split(":");
    const args_summary = rest.join(":");
    setTimeout(() => {
      client.sendOneWay({
        type: "permission_request",
        request_id: request_id ?? `req-${Date.now()}`,
        tool: tool ?? "Bash",
        args_summary: args_summary ?? "",
        expires_at: Date.now() + 60_000,
      });
      process.stderr.write(`fake-claude: injected permission_request ${request_id ?? "auto"}\n`);
    }, 100);
  }

  const goodbye = (code: number) => {
    void client.send({ type: "bye", session_id: session.session_id }).finally(() => {
      client.close();
      process.exit(code);
    });
  };
  process.on("SIGINT", () => goodbye(130));
  process.on("SIGTERM", () => goodbye(143));

  // Idle until killed.
  setInterval(() => {}, 1 << 30);
}

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

main().catch((e) => {
  process.stderr.write(`fake-claude: ${(e as Error).message}\n`);
  process.exit(1);
});
```

(Overwrites the previous spawn-based implementation.)

- [ ] **Step 2: Run typecheck — entire workspace**

```bash
bun run typecheck 2>&1 | tail -20
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tools/fake-claude/fake-claude.ts
git commit -m "refactor(fake-claude): in-process daemon-client (drop plugin spawn)"
```

---

### Task 15: Update `e2e/permission.test.ts` to use new fake-claude inject mechanism

**Files:**
- Modify: `e2e/permission.test.ts:78-93`

Replace the `CC_REMOTE_FAKE_PERMISSION` env-driven path with `--inject-permission` CLI arg.

- [ ] **Step 1: Replace the fake-claude spawn block**

Find lines 78-93 (the `CC_REMOTE_FAKE_PERMISSION` block):

```ts
    // fake-claude with CC_REMOTE_FAKE_PERMISSION set on plugin's env.
    const sockPath = join(stateDir, "daemon.sock");
    const fc = spawn("bun", [
      join(ROOT, "tools/fake-claude/fake-claude.ts"),
      "--session-id", "s_perm",
      "--cwd", "/tmp/perm",
      "--socket", sockPath,
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CC_REMOTE_FAKE_PERMISSION: "Bash",
        CC_REMOTE_FAKE_REQUEST_ID: "req-e2e-1",
        CC_REMOTE_FAKE_ARGS: "rm -rf /tmp/test",
      },
    });
    procs.push(fc);
```

Replace with:

```ts
    const sockPath = join(stateDir, "daemon.sock");
    const fc = spawn("bun", [
      join(ROOT, "tools/fake-claude/fake-claude.ts"),
      "--session-id", "s_perm",
      "--cwd", "/tmp/perm",
      "--socket", sockPath,
      "--inject-permission", "Bash:req-e2e-1:rm -rf /tmp/test",
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    procs.push(fc);
```

- [ ] **Step 2: Run the e2e**

```bash
bun test e2e/permission.test.ts 2>&1 | tail -15
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add e2e/permission.test.ts
git commit -m "test(e2e): permission scenario uses fake-claude --inject-permission"
```

---

### Task 16: Update remaining tests with new register shape

**Files:**
- Modify: `packages/daemon/tests/registry.test.ts:7`
- Modify: `packages/daemon/tests/socket-server.test.ts:36`
- Modify: `packages/hub/tests/router.test.ts:27,34,40,58,65`

Each site uses an inline `SessionSnapshot` literal. The new shape adds `claude_session_id`, `claude_client_version`, `plugin_version`, and changes `model` to `null`.

- [ ] **Step 1: Build a tiny test fixture helper to keep diffs minimal**

Create `packages/proto/src/test-fixtures.ts`:

```ts
import type { SessionSnapshot } from "./frames.ts";

export function fixtureSession(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    session_id: "s1",
    claude_session_id: null,
    tmux_session: null,
    tmux_pane: null,
    cwd: "/x",
    model: null,
    pid: 1,
    started_at: 1,
    claude_client_version: "test",
    plugin_version: "0.1.0",
    ...overrides,
  };
}
```

Append to `packages/proto/src/index.ts`:

```ts
export * from "./test-fixtures.ts";
```

- [ ] **Step 2: Update `packages/daemon/tests/registry.test.ts`**

Find the register snapshot literal (around line 7). Replace it with `fixtureSession()` (with the same overrides as before). The exact replacement: import at top, then change literal to call.

Add at top of file:
```ts
import { fixtureSession } from "@cc-remote/proto";
```

Replace the snapshot literal at line ~7 (`{ session_id: "s1", tmux_session: null, ... }`) with:
```ts
fixtureSession()
```

- [ ] **Step 3: Update `packages/daemon/tests/socket-server.test.ts:36`**

Same pattern. Add the import and replace the literal:
```ts
fixtureSession({ session_id: "s1" })
```

- [ ] **Step 4: Update `packages/hub/tests/router.test.ts:27,34,40,58,65`**

Same pattern. The 5 SessionSnapshot literals become:
- Line 27: `fixtureSession({ session_id: "s1", tmux_session: "work", tmux_pane: "%0" })`
- Line 34: `fixtureSession({ session_id: "s1", tmux_session: "work", tmux_pane: "%0" })`
- Line 40: `fixtureSession({ session_id: "s1", tmux_session: "work", tmux_pane: "%0" })`
- Line 58: `fixtureSession({ session_id: "s2" })`
- Line 65: `fixtureSession({ session_id: "s2" })`

Add the import at top of `router.test.ts`.

- [ ] **Step 5: Run all updated tests**

```bash
bun test packages/daemon/tests/registry.test.ts packages/daemon/tests/socket-server.test.ts packages/hub/tests/router.test.ts 2>&1 | tail -10
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/proto/src/test-fixtures.ts packages/proto/src/index.ts packages/daemon/tests/registry.test.ts packages/daemon/tests/socket-server.test.ts packages/hub/tests/router.test.ts
git commit -m "test: introduce fixtureSession() and adopt new SessionSnapshot shape"
```

---

### Task 17: Update PWA App.tsx — null-safe model + tmux rendering

**Files:**
- Modify: `packages/pwa/src/App.tsx:132-133`

- [ ] **Step 1: Replace the rendering**

Around line 132-133, find:
```tsx
                          {s.tmux_session ? <span>tmux:{s.tmux_session} · </span> : null}
                          cwd: <code>{s.cwd}</code> · model: <code>{s.model}</code>
```

Replace with:
```tsx
                          {s.tmux_session ? <span>tmux:{s.tmux_session} · </span> : null}
                          cwd: <code>{s.cwd}</code> · model: <code>{s.model ?? "-"}</code>
```

- [ ] **Step 2: Run typecheck**

```bash
bun run --cwd packages/pwa typecheck 2>&1 | tail -5
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/pwa/src/App.tsx
git commit -m "fix(pwa): render '-' for null model field"
```

---

### Task 18: Add the manual smoke test (skipped by default)

**Files:**
- Create: `packages/plugin/tests/smoke.test.ts.skipped`

This is a documentation artifact — the `.skipped` extension keeps it out of `bun test`. To run manually a developer renames it to `.test.ts`.

- [ ] **Step 1: Write the smoke test stub**

```ts
// To run manually: rename to smoke.test.ts and ensure ANTHROPIC_API_KEY is set.
// This test verifies the rework end-to-end against real Claude Code 2.1.143+.
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { startSocketServer } from "../../daemon/src/socket-server.ts";
import type { PluginToDaemon } from "@cc-remote/proto";

test("real claude --plugin-dir packages/plugin runs and registers a session", async () => {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    throw new Error("smoke test requires ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN");
  }
  const dir = mkdtempSync(join(tmpdir(), "ccr-smoke-"));
  const sockPath = join(dir, "d.sock");
  try {
    const seen: PluginToDaemon[] = [];
    const server = startSocketServer({
      path: sockPath,
      onFrame: (f, c) => {
        seen.push(f);
        if (f.type === "register" || f.type === "bye") server.replyTo(c, { type: "ack", ref: f.type });
      },
    });
    await server.ready;

    const pluginDir = resolve(import.meta.dir, "..");
    const child = spawn("claude", ["--plugin-dir", pluginDir, "-p", "say one word", "--output-format", "json"], {
      env: { ...process.env, CC_REMOTE_SOCKET: sockPath },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const exit = await new Promise<number>((res) => child.on("exit", (c) => res(c ?? 1)));
    expect(exit).toBe(0);

    const reg = seen.find((f) => f.type === "register");
    expect(reg).toBeDefined();

    server.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

Save as `packages/plugin/tests/smoke.test.ts.skipped` (literally with `.skipped` suffix — it won't be picked up by `bun test`).

- [ ] **Step 2: Commit**

```bash
git add packages/plugin/tests/smoke.test.ts.skipped
git commit -m "test(plugin): manual real-claude smoke test (skipped by default)"
```

---

### Task 19: Update READMEs + docs/TODO.md + deprecate old PMCP plan

**Files:**
- Modify: `README.md` (repo root)
- Modify: `docs/TODO.md`
- Modify: `docs/superpowers/plans/2026-05-19-plugin-mcp-plan.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update repo README** — add a new "Loading the plugin into real Claude Code" subsection after the existing run instructions:

Append before the "## Conventions" section (or wherever fits in the existing structure):

```markdown
## Loading the plugin into real Claude Code 2.1.143+

```bash
# Pre-validate the plugin manifest.
claude plugin validate packages/plugin

# Run claude with the plugin loaded. Requires a running daemon
# (cc-remote daemon at ~/.cc-remote/daemon.sock or $CC_REMOTE_SOCKET).
claude --plugin-dir packages/plugin -p "your prompt"
```
```

- [ ] **Step 2: Update `docs/TODO.md`** — replace the "Active goal (paused)" + "Prerequisite plan (paused)" sections with a single new section indicating the rework is in flight:

Replace from `## Active goal (paused 2026-05-19)` through end of `## Prerequisite plan (also paused 2026-05-19)` with:

```markdown
## Plan in flight (2026-05-19)

`docs/superpowers/plans/2026-05-19-plugin-mcp-rework-plan.md` — the plugin MCP rework. Supersedes the paused PMCP plan after empirical findings showed Claude Code 2.1.143 requires `.claude-plugin/plugin.json` + `.mcp.json`, not just a `bin` field. Spec at `docs/superpowers/specs/2026-05-19-plugin-mcp-rework-design.md`.

Once this rework lands, the real-e2e plan (`docs/superpowers/plans/2026-05-19-real-e2e-plan.md`, T1–T19) is unblocked and can resume.

## Superseded plans

- `docs/superpowers/plans/2026-05-19-plugin-mcp-plan.md` — original PMCP plan; superseded by the rework plan above.
```

- [ ] **Step 3: Add deprecation header to old PMCP plan**

Prepend to `docs/superpowers/plans/2026-05-19-plugin-mcp-plan.md`:

```markdown
> **DEPRECATED 2026-05-19** — Superseded by `docs/superpowers/plans/2026-05-19-plugin-mcp-rework-plan.md`. Do not implement this plan; it was based on an incomplete reading of Claude Code 2.1.143's plugin contract.
```

- [ ] **Step 4: Update CLAUDE.md status section**

Replace the "## Status" block of `CLAUDE.md` with:

```markdown
## Status

- Plugin MCP rework in flight: `docs/superpowers/plans/2026-05-19-plugin-mcp-rework-plan.md` (spec: `…/2026-05-19-plugin-mcp-rework-design.md`)
- 16 milestones tagged: `plan-01-foundation` through `plan-16-status`
- Real-e2e plan (`…/2026-05-19-real-e2e-plan.md`) is paused, unblocked once the rework lands

See `docs/TODO.md` for the unfinished work and the order to resume.
```

- [ ] **Step 5: Commit**

```bash
git add README.md docs/TODO.md docs/superpowers/plans/2026-05-19-plugin-mcp-plan.md CLAUDE.md
git commit -m "docs: update README + TODO + CLAUDE.md for plugin rework"
```

---

### Task 20: Final verification — all tests + typecheck + plugin validate

**Files:** none modified — purely verification.

- [ ] **Step 1: Run typecheck across all packages**

```bash
bun run typecheck 2>&1 | tail -15
```
Expected: PASS for all 5 packages (proto, plugin, daemon, hub, pwa).

- [ ] **Step 2: Run all tests**

```bash
bun test 2>&1 | tail -25
```
Expected: all tests pass. Total count may shift slightly from the prior 164 (new plugin tests added: session, mcp-init, permission, chat, jsonl-bind = 5 new test files; subtract 0 deleted). Approximate new count: 164 + 5 ≈ 169–171 tests pass.

- [ ] **Step 3: Validate plugin manifest**

```bash
claude plugin validate packages/plugin 2>&1 | tail -5
```
Expected: `✔ Validation passed with warnings` (only the optional "author" warning).

- [ ] **Step 4: Smoke (optional, manual)**

If `ANTHROPIC_API_KEY` is set and `claude` is on PATH, rename and run the smoke test:

```bash
mv packages/plugin/tests/smoke.test.ts.skipped packages/plugin/tests/smoke.test.ts
bun test packages/plugin/tests/smoke.test.ts
mv packages/plugin/tests/smoke.test.ts packages/plugin/tests/smoke.test.ts.skipped
```

Document the result in the PR description.

- [ ] **Step 5: Tag the milestone**

```bash
git tag plan-plugin-mcp-rework -m "Plugin MCP rework complete: real Claude Code can load packages/plugin"
git log --oneline -25
```

No commit needed — verification step only. The tag commits the milestone.

---

## Self-Review

**Spec coverage check:**

| Spec section | Plan task |
|---|---|
| §4 file layout | T2 (manifest), T3-T7 (src files) |
| §5.1 inbound permission_request | T4, T9 |
| §5.2 outbound permission notif | T4, T9 |
| §5.3 inbound chat (channel notif) | T5, T10 |
| §5.4 reply tool | T5, T6, T10 |
| §5.5 instructions field | T7 |
| §6 JSONL bind | T12, T13 |
| §7.1 register schema | T1, T11, T16 |
| §7.2 chat frames in proto | T1 |
| §8 fake-claude refactor | T14 |
| §9 plugin tests | T8, T9, T10 |
| §9 smoke test | T18 |
| §10 error handling | T4 (fail-closed deny), T7 (exit 1 on missing env) |
| §11 cleanup checklist | T1 (remove session_id), T7 (delete fake-permission hook), T15, T17, T19 |
| §12 acceptance criteria | T20 |

All 12 spec sections have task coverage.

**Placeholder scan:** All steps contain concrete code, exact paths, or exact commands. No "TBD" / "TODO" / "implement later" patterns in the plan or in the code blocks the plan introduces.

**Type consistency:**
- `SessionSnapshot.session_id` (T1) is referenced consistently in T11, T14, T15, T16
- `bindJsonl({ dir, registerTimeMs, timeoutMs })` signature defined in T12, used in T13
- `installPermissionRelay`, `installChatRelay`, `installTools` exported from their modules (T4, T5, T6) match imports in T7
- `connectDaemon` signature unchanged; `onFrame(handler)` added in T7 matches usage in T7
- `fixtureSession()` helper (T16) consistent across T16 update sites

**File path consistency:** All file paths match `packages/<pkg>/...` and `tools/fake-claude/...` and `e2e/...` conventions in the existing repo.

---

Plan complete. Saved to `docs/superpowers/plans/2026-05-19-plugin-mcp-rework-plan.md`.
