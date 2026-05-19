# Plugin MCP Rework — Design Spec

**Date:** 2026-05-19
**Status:** Draft, awaiting user review
**Project:** open-cc-remote
**Supersedes:** `docs/superpowers/plans/2026-05-19-plugin-mcp-plan.md` (PMCP, paused)

---

## 1. Goal

Rebuild `packages/plugin/` so that real Claude Code 2.1.143+ can load it via `claude --plugin-dir packages/plugin`. The plugin participates in the channel-permission protocol AND in the bidirectional chat protocol used by official channel plugins (telegram/discord/imessage/fakechat). The previous in-tree plugin was a Unix-socket-only client; it cannot be loaded by current Claude Code. This spec defines the clean replacement — single mode (MCP-only), no dual-mode hacks, scoped for v1 (full bidirectional chat, no marketplace publish).

## 2. What we confirmed empirically (probe results)

A throwaway plugin (`/tmp/cc-probe-plugin`) was loaded via `claude --plugin-dir <path> -p "..."` against Claude Code 2.1.143. Results:

**Plugin manifest contract (validated by `claude plugin validate`):**
- Required: `<plugin>/.claude-plugin/plugin.json` with `name`, `description`, `version`, `keywords`. No `bin`, no MCP config in this file.
- Required for MCP servers: `<plugin>/.mcp.json` at plugin root: `{ "mcpServers": { "<name>": { "command": "bun", "args": ["run", "--cwd", "${CLAUDE_PLUGIN_ROOT}", "--shell=bun", "--silent", "start"] } } }`. The `${CLAUDE_PLUGIN_ROOT}` is substituted at spawn.
- Recommended: `package.json` with a `start` script that the spawn command invokes.

**Env vars Claude Code passes to the spawned MCP server:**
- `CLAUDE_PROJECT_DIR` — the cwd Claude Code was invoked in (RELIABLE; this is what we use to find the JSONL dir).
- `CLAUDE_PLUGIN_ROOT` — the plugin install dir.
- `CLAUDE_PLUGIN_DATA` — per-plugin persistent state dir (`~/.claude/plugins/data/<plugin-name>`).
- `CLAUDECODE=1`
- `CLAUDE_CODE_SESSION_ID` is **inherited from the parent shell**, not generated for this session. **Do not trust it.**

**MCP `initialize` `clientInfo`:** `{ name: "claude-code", title, version, description, websiteUrl }`. No session id, no cwd.

**Therefore:** there is no first-class way to obtain Claude Code's per-session id at plugin startup. We use a JSONL-watch heuristic (Section 6).

## 3. Out of scope

- Marketplace publishing / `claude plugin install` — defer to v2. The plugin is loaded via `--plugin-dir packages/plugin` from the dev checkout only.
- Bundling proto sources into the plugin dir — `packages/plugin` stays a bun workspace package; `@cc-remote/proto` is reached via workspace symlinks.
- Real e2e against `claude --plugin-dir` — this rework unblocks the paused real-e2e plan, but the e2e suite itself is a separate plan.
- Changes to hub / PWA UI for chat — chat frames cross the layers, but the PWA chat UI work is a separate plan tracked under `docs/TODO.md`.

## 4. Plugin file layout

```
packages/plugin/
├── .claude-plugin/
│   └── plugin.json           # name, description, version, keywords
├── .mcp.json                 # mcpServers.cc-remote.{command,args}
├── package.json              # type:module, scripts.start, deps
└── src/
    ├── index.ts              # entry: bootstrap MCP + connect daemon
    ├── daemon-client.ts      # (kept) Unix socket client
    ├── session.ts            # plugin_session_id + cwd + start metadata
    ├── permission.ts         # permission_request handler ↔ permission notification emit
    ├── chat.ts               # daemon chat_in → channel notif emit; reply tool → daemon chat_out
    └── tools.ts              # MCP tools/list = [reply]
```

**Deletions from current `src/index.ts`:**
- All standalone-mode behavior (no MCP host detection, no fallback)
- `CC_REMOTE_FAKE_PERMISSION` test hook
- `process.stdin.resume()` keep-alive loop (MCP server's stdio handles this)

**File sizes target:** each module < 200 lines. `index.ts` is just bootstrap (compose `daemon-client` + `session` + `permission` + `chat` into a running MCP server).

## 5. Plugin ↔ Claude Code wire contract (MCP stdio)

Plugin instantiates `Server` from `@modelcontextprotocol/sdk/server/index.js` with:

```ts
{ name: "cc-remote", version: "<pkg.version>" }
{
  capabilities: {
    tools: {},
    experimental: {
      "claude/channel": {},
      "claude/channel/permission": {},
    },
  },
  instructions: <see §5.4>,
}
```

Connected via `StdioServerTransport`.

### 5.1 Inbound notification — permission request

Method: `notifications/claude/channel/permission_request`
Params shape (per official telegram/discord/imessage source, file references in `docs/superpowers/research/channel-permission-protocol.md`):
```
{ request_id: string,    // 5 chars [a-km-z]
  tool_name: string,
  description: string,
  input_preview: string }
```
Plugin action: forward to daemon as a `permission_request` proto frame (see §7.1).

### 5.2 Outbound notification — permission decision

Method: `notifications/claude/channel/permission`
Params: `{ request_id: string, behavior: "allow" | "deny" }`
Trigger: daemon sends `permission_reply` frame (existing). Plugin emits via `mcp.notification(...)`.

### 5.3 Outbound notification — inbound chat (PWA → Claude)

Method: `notifications/claude/channel`
Params (matching telegram precedent):
```
{ content: string,
  meta: {
    chat_id: string,         // for cc-remote, "pwa" — single channel per session
    message_id: string,      // ULID-style, for reply_to threading
    user: string,            // PWA bearer subject (email)
    user_id: string,         // PWA bearer sub claim
    ts: number,              // unix seconds
  } }
```
Trigger: daemon sends `chat_in` frame. Plugin emits via `mcp.notification(...)`. Claude Code injects this as a `<channel source="cc-remote" chat_id="pwa" message_id="..." user="..." ts="...">...</channel>` in the next user-turn context.

### 5.4 Tool — `reply`

Listed by `tools/list`. Schema:
```
{ name: "reply",
  description: "Send a message to the cc-remote PWA. Pass reply_to (message_id) for threading.",
  inputSchema: {
    type: "object",
    properties: {
      text:     { type: "string" },
      reply_to: { type: "string" },
    },
    required: ["text"],
  } }
```
Action: emit a `chat_out` proto frame to daemon with `{ content: text, reply_to?, ts }`. Tool result: `{ content: [{ type: "text", text: "delivered" }] }`. (Failure to reach daemon → throw; the tool errors back to Claude.)

`files` parameter is intentionally omitted in v1 — no file upload roundtrip yet.

### 5.5 `instructions` field (sent to Claude Code at handshake)

```
The PWA user reads cc-remote, not this session. Anything you want them to see must go through the reply tool — your transcript output never reaches them.

Messages from the PWA arrive as <channel source="cc-remote" chat_id="pwa" message_id="..." user="..." ts="...">. Reply with the reply tool. Use reply_to (set to a message_id) only when threading; for normal responses, omit reply_to.

Permission prompts are routed to the PWA. The PWA user authenticates via SAP IAS before they can approve or deny — you can trust the channel.
```

## 6. JSONL ↔ session linkage strategy

Goal: daemon needs to map `plugin_session_id` → real Claude session JSONL file at `~/.claude/projects/<encoded-cwd>/<claude-session-uuid>.jsonl` so the existing watcher can replay events to the PWA.

**Algorithm** (runs in daemon when a `register` frame is received):
1. Read `cwd` from the register frame (= `CLAUDE_PROJECT_DIR` the plugin captured at startup).
2. Compute the JSONL dir: `~/.claude/projects/<encode(cwd)>/`. Encoding: replace `/` with `-`, leading `-` stays. Daemon already does this for the v1 watcher — reuse the helper.
3. Open an `fs.watch` on that dir starting at register receipt time.
4. The first `.jsonl` file with `mtime >= register_time - 2s` (small back-skew tolerance) → parse the file basename for the UUID → call this the `claude_session_id` for this plugin session.
5. Bind `plugin_session_id ↔ claude_session_id`. Update the daemon's session snapshot.
6. **Timeout:** if no JSONL appears within `JSONL_BIND_TIMEOUT_MS = 30000`, mark the session `jsonl_status: "missing"` and continue. Permission relay and chat still work; only history scrollback is unavailable.

**Edge cases:**
- Multiple Claude sessions launched in the same cwd within the bind window → races. v1: bind in order of `mtime`. Documented limitation; rare in practice (one user, one cwd at a time).
- JSONL appears AFTER bind window → not bound; PWA shows "history unavailable" banner for that session.
- `CLAUDE_PROJECT_DIR` missing or empty → register fails fast at the plugin (clear error to stderr, exit 1).

## 7. Plugin ↔ daemon proto changes

Existing frames (kept):
- `register`, `bye`, `permission_request` (plugin→daemon), `permission_reply` (daemon→plugin).

### 7.1 Modified frame: `register`

Old fields: `session_id`, `tmux_session`, `tmux_pane`, `cwd`, `model`, `pid`, `started_at`.

**New shape:**
```
{ type: "register",
  session: {
    plugin_session_id: string,    // UUID, generated by plugin at startup
    cwd: string,                  // = CLAUDE_PROJECT_DIR
    pid: number,
    started_at: number,           // unix seconds
    claude_client_version: string,// from MCP initialize.clientInfo.version
    plugin_version: string,       // from package.json
    tmux_session: string | null,  // from process.env.TMUX_SESSION (inherited from parent shell), null otherwise
    tmux_pane:    string | null,  // from process.env.TMUX_PANE,    null otherwise
  } }
```

**Removed:** `session_id` (replaced by daemon-side `claude_session_id` derived per §6) and `model` (not available from MCP env or `initialize.clientInfo`; daemon will populate `model: null` until it can be parsed from the bound JSONL header in a future enhancement).

**Field-use crosswalk to PWA UI** (`packages/pwa/src/App.tsx`):
- `cwd` → still shown verbatim, populated as before
- `model` → render as `"-"` when null. Minor visual regression, acceptable for v1.
- `tmux_session` → shown when non-null (existing render); null in non-tmux contexts. No change from current behavior when tmux is absent.

### 7.2 New frames: chat

```
chat_in (daemon → plugin):
  { type: "chat_in",
    plugin_session_id: string,
    message_id: string,
    user: string,
    user_id: string,
    content: string,
    ts: number }

chat_out (plugin → daemon):
  { type: "chat_out",
    plugin_session_id: string,
    content: string,
    ts: number,
    reply_to: string | null }
```

Both frames added to `packages/proto/`. The hub-side proto and PWA proto changes are out of scope for THIS plan — they'll be picked up in a follow-on chat-routing plan.

## 8. fake-claude refactor

**Current state:** `tools/fake-claude/fake-claude.ts` spawns `packages/plugin/src/index.ts` as a child process; the plugin then connects to daemon via Unix socket. Tests rely on this path to register a fake session.

**New state:** fake-claude no longer spawns the plugin. Instead, it imports `daemon-client.ts` directly from `@cc-remote/plugin` and:
1. Generates a synthetic `plugin_session_id`.
2. Calls `connectDaemon(socketPath)`.
3. Sends a `register` frame matching §7.1 (with synthetic `cwd`, `claude_client_version: "fake"`, etc.).
4. Continues writing fake JSONL events as before.
5. On test teardown: sends `bye`, closes the socket.

**Why:** the plugin process now has a runtime dependency on Claude Code's MCP host (stdio framing). Spawning it without that host would either hang or fail. fake-claude doesn't need to be a Claude Code; it just needs to put a session in the daemon's view. Going in-process via `daemon-client` is shorter, faster, and cuts the dual-mode complexity that bit the previous PMCP attempt.

**Affected tests** (audit during execution; expected adjustments are mechanical):
- `e2e/snapshot.test.ts` — uses fake-claude; probably needs no test-side change (fake-claude's external interface stays the same: "create a fake session in the daemon").
- `packages/plugin/tests/daemon-client.test.ts` — unaffected, tests the socket client directly.
- Hub/daemon tests that import fake-claude — same external interface; should adapt cleanly.

## 9. Test plan for the rework itself

Three new plugin-level tests (replacing what PMCP-T2 through PMCP-T6 stubbed out):

**`packages/plugin/tests/mcp-init.test.ts`** — spawn `bun src/index.ts`, attach a `StdioClientTransport` from the MCP SDK, send `initialize`, assert response carries our two `experimental` capabilities. Then `tools/list` → `[reply]`. Then close.

**`packages/plugin/tests/permission.test.ts`** — start an in-process mock daemon Unix socket. Spawn plugin via stdio. Drive: client sends `notifications/claude/channel/permission_request` → assert mock daemon receives matching `permission_request` frame → mock daemon sends `permission_reply` → assert client receives `notifications/claude/channel/permission` notification with same `request_id`.

**`packages/plugin/tests/chat.test.ts`** — same mock-daemon harness. Test (a): client calls `tools/call` for `reply` with `{ text: "hi" }` → assert mock daemon sees `chat_out` frame. Test (b): mock daemon sends `chat_in` → assert client receives `notifications/claude/channel` notification with matching content + meta.

**Smoke test (manual / CI-skipped without `ANTHROPIC_API_KEY`)** — `packages/plugin/tests/smoke.test.ts.skipped-by-default`: invoke `claude --plugin-dir packages/plugin -p "echo hi"`, assert daemon's mock socket receives a `register` frame within 10s. Documents the integration but doesn't gate CI.

**Existing 164 tests:** run all after the rework. Expected: pass. The fake-claude refactor and proto register-shape change ripple through daemon/hub tests; minor adjustments allowed but no test should be deleted or its assertions weakened.

## 10. Error handling and diagnostics

| Failure | Behavior |
|---|---|
| `CLAUDE_PROJECT_DIR` missing in env | Plugin writes error to stderr, exits 1. Claude Code surfaces this. |
| Daemon socket unreachable at startup | Same: stderr + exit 1. (Today the plugin exits 0 silently — change to non-zero; a missing daemon is a real misconfiguration, not a test scenario.) |
| MCP `initialize` never arrives within 5s of stdio open | Stderr warning, exit 1. (Indicates broken host wiring.) |
| Daemon drops connection mid-session | Plugin logs to stderr; emits an MCP `notifications/claude/channel` frame with system meta (`{ user: "system", content: "cc-remote daemon disconnected" }`) so Claude knows; then exits 0. The Claude session continues without the channel — its own decision how to respond. |
| `reply` tool called but daemon write fails | Tool throws back to Claude with the daemon error string. Claude can decide whether to retry or surface to PWA via a different path (it can't — but that's its problem to recognize). |
| `permission_request` received but daemon write fails | Plugin emits `permission` notification with `behavior: "deny"` to fail-closed and stderr-logs the underlying daemon error. (Better: silent timeout — but Claude will hang the tool call. Fail-closed is safer for v1.) |

## 11. Migration / cleanup checklist

To be expanded in the implementation plan, but flagged here:

- Delete `CC_REMOTE_FAKE_PERMISSION` references from any test that uses it (the new `permission.test.ts` covers the same intent via mock daemon).
- Delete `packages/plugin/src/index.ts` standalone branches.
- Update `packages/proto/` register schema; downstream daemon code paths must adapt.
- Update `tools/fake-claude/fake-claude.ts` to in-process mode.
- Update `packages/pwa/src/App.tsx` line 133 to render `model` as `"-"` when null.
- Update `README.md` (root + packages/plugin/) with `--plugin-dir packages/plugin` invocation example.
- Update `docs/TODO.md`: mark PMCP plan as superseded by the new plan; clarify real-e2e is unblocked once this rework + the chat-routing plan land.

## 12. Acceptance criteria

This rework is done when ALL of:

1. `claude plugin validate packages/plugin` passes.
2. `claude --plugin-dir packages/plugin -p "say hi"` runs to completion; daemon receives a `register` frame within 10s; daemon binds the JSONL within 30s of the prompt finishing (assuming default JSONL persistence is on).
3. New plugin-level tests (`mcp-init`, `permission`, `chat`) all pass.
4. Existing 164 tests pass after fake-claude refactor + proto register changes (count may shift slightly as old standalone-spawn-specific assertions get rewritten).
5. `bun run typecheck` clean across all 5 packages.
6. The plugin can drive a real permission roundtrip with a real `claude` invocation (smoke test); manual verification logged in the PR description.

## 13. Open implementation questions (resolved during plan-writing, not blocking design)

1. **`mtime` precision under `fs.watch`** — macOS APFS gives sub-second mtime; the §6 algorithm assumes second-level resolution. If race conditions show up in tests, fall back to `inotify`-style "first new file matching `*.jsonl`" with a small grace period.
2. **`reply` tool result content** — do we return the daemon's ack, or a synthetic "delivered" string? The PWA UI cares whether the message was actually broadcast; for v1, "delivered" is enough; richer status is a future enhancement.
3. **`instructions` field length** — the §5.5 draft is moderate length. Telegram's is much longer. Tune during integration testing if Claude misbehaves with channel injection.
4. **Multiple Claude sessions in the same cwd** — §6 race window. Document as known limitation; if it bites, add a stat-based "PID inspection in JSONL header" pass to disambiguate.

## 14. Related documents

- `docs/superpowers/research/channel-permission-protocol.md` — wire format research, still valid
- `docs/superpowers/plans/2026-05-19-plugin-mcp-plan.md` — PMCP plan, now superseded
- `docs/superpowers/plans/2026-05-19-real-e2e-plan.md` — real-e2e plan; unblocked by this rework
- `docs/superpowers/specs/2026-05-18-open-cc-remote-design.md` — original v1 design
- `docs/TODO.md` — paused-work index
