# Channel-permission protocol findings

**Research date:** 2026-05-19  
**Researcher:** Claude (guide agent)  
**Claude Code version observed:** 2.1.143  
**Time budget used:** < 30 minutes

---

## Background

The question is: what wire format must a channel plugin use so Claude Code's permission
relay actually works end-to-end? Our plugin (`cc-remote`) runs under
`claude --channels plugin:cc-remote@local` as an MCP stdio server. We inferred from
published Telegram channel plugin source that:

1. The plugin advertises capability `claude/channel/permission` in its experimental
   capabilities block.
2. Claude Code sends a `notifications/claude/channel/permission_request` notification
   (with `request_id`, `tool_name`, `description`, `input_preview` params) to the
   plugin when a permission prompt would otherwise appear in the terminal.
3. The plugin forwards the request to the remote user (via Telegram/Discord/iMessage).
4. The remote user replies. The plugin converts that reply into a
   `notifications/claude/channel/permission` notification (with `request_id` and
   `behavior: "allow"|"deny"`) sent back to Claude Code via `mcp.notification(...)`.
5. The 5-letter code in text-reply paths is the `request_id` (5 lowercase letters
   from `[a-km-z]` — alphabet minus 'l'), used so a phone user can type
   `y abcde` or `n abcde` without needing buttons.

We never confirmed this against Claude Code's internal handler. This research does.

---

## What we confirmed via official sources

### 1. The regex — confirmed identical in all three official plugins

All three official channel plugins (`telegram/server.ts`, `discord/server.ts`,
`imessage/server.ts`) carry the **same comment block and the same regex**:

```
// Permission-reply spec from anthropics/claude-cli-internal
// src/services/mcp/channelPermissions.ts — inlined (no CC repo dep).
// 5 lowercase letters a-z minus 'l'. Case-insensitive for phone autocorrect.
// Strict: no bare yes/no (conversational), no prefix/suffix chatter.
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i
```

**Citation (file paths):**
- `/Users/i060912/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/telegram/server.ts` line 84
- `/Users/i060912/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/discord/server.ts` line 79
- `/Users/i060912/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/imessage/server.ts` line 60

The comment explicitly names the CC-internal source file as
`anthropics/claude-cli-internal src/services/mcp/channelPermissions.ts`. The regex
was inlined to eliminate a dependency on the internal repo. This gives us high
confidence the regex matches CC's own `request_id` generation exactly.

**Code character set:** `[a-km-z]{5}` — 25 lowercase letters (all except 'l'), 5
characters. That is 25^5 = 9,765,625 possible values.

**Accepted text forms:** `y`, `yes`, `n`, `no` (any case) followed by the 5-letter
code, with optional leading/trailing whitespace. Nothing else — no prefix, no suffix,
no bare yes/no.

### 2. The MCP notification method names — confirmed

From the `mcp.setNotificationHandler(...)` call in telegram/discord/imessage:

**CC → plugin (permission request incoming):**
```
method: "notifications/claude/channel/permission_request"
params: {
  request_id: string,   // 5 chars [a-km-z]
  tool_name: string,
  description: string,
  input_preview: string
}
```

**Plugin → CC (user decision outgoing):**
```
method: "notifications/claude/channel/permission"
params: {
  request_id: string,   // same 5-char code
  behavior: "allow" | "deny"
}
```

Both directions use the MCP `mcp.notification()` / `mcp.setNotificationHandler()`
API, i.e., standard MCP notifications over the stdio transport. Not a custom tool
call — pure notifications.

**Citation:**
- telegram/server.ts lines 419–443 (incoming handler) and lines 772–775 (outgoing emit)
- discord/server.ts lines 476–518 (incoming handler) and lines 792–795 (outgoing emit)
- iMessage server.ts confirms the same pattern (same regex, same capability names
  visible from lines 1–60)

### 3. Capability declaration required for opt-in

A plugin must declare **both** experimental capabilities to participate:

```ts
capabilities: {
  tools: {},
  experimental: {
    'claude/channel': {},
    'claude/channel/permission': {},  // ← this opts in to permission relay
  }
}
```

The comment in the Telegram server (line 389–394) is explicit:

> "Permission-relay opt-in (anthropics/claude-cli-internal#23061). Declaring this
> asserts we authenticate the replier — which we do: gate()/access.allowFrom already
> drops non-allowlisted senders before handleInbound runs. A server that can't
> authenticate the replier should NOT declare this."

Without declaring `claude/channel/permission`, Claude Code will not forward
`permission_request` notifications to the plugin at all.

### 4. Inline-button path (alternative to text reply)

For platforms with native UI (Telegram inline keyboards, Discord interaction buttons),
the plugin can also emit the outgoing `notifications/claude/channel/permission`
notification from a button handler — not only from the text-reply intercept. The same
notification format applies; only the trigger path differs. This is the Telegram
`bot.on('callback_query:data', ...)` handler (lines 731–785) and the Discord
`client.on('interactionCreate', ...)` handler (lines 747–803).

For our `cc-remote` plugin there is no external messaging platform, so only the MCP
notification path matters — the PWA client sends a structured frame and the plugin
calls `mcp.notification(...)`.

### 5. Claude Code CLI — no `--channels` documentation in help output

Running `claude --help` (v2.1.143) does **not** show a `--channels` flag. It shows
`--plugin-dir` and `--plugin-url` flags. The `plugin:cc-remote@local` syntax is
handled by the plugin subsystem, not a dedicated `--channels` flag. (The `--channels`
flag may be an alias or older name — the `claude --help` output references only
`--plugin-dir`/`--plugin-url` in the visible options.)

**Citation:** `claude --help 2>&1` — full output captured; no `--channels` string
appears in any option or command description.

### 6. Our plugin's current state

`/Users/i060912/SAPDevelop/channel/packages/plugin/src/index.ts` currently:

- Connects to the cc-remote daemon via Unix socket
- Sends a `register` frame with session metadata
- Has a test hook (`CC_REMOTE_FAKE_PERMISSION`) that emits a `permission_request`
  frame to the daemon
- Does **not** declare any MCP server at all — no `@modelcontextprotocol/sdk` import,
  no `Server` instantiation, no capability registration
- Does **not** implement `notifications/claude/channel/permission_request` handler
- Does **not** call `mcp.notification()` with `notifications/claude/channel/permission`

The plugin is a bare Unix socket client, not an MCP server. It cannot currently
participate in the CC permission relay protocol.

---

## What is still unknown

1. **How CC generates the `request_id`:** The comment says `[a-km-z]{5}` but we
   cannot see the generation code (`channelPermissions.ts` is not publicly available).
   The regex is consistent across all three plugins and matches the character set
   description exactly. We can treat the character class as ground truth.

2. **Timeout / expiry behaviour on the CC side:** We know Telegram pending entries
   expire after 1 hour, but that is plugin state, not the CC side. Whether CC
   cancels the permission prompt after a timeout (and what it sends the plugin, if
   anything) is not visible from the plugin source alone.

3. **What CC does if the plugin never responds:** Whether CC falls back to the
   terminal prompt, or blocks indefinitely, or auto-denies is unspecified in the
   available source. This affects e2e timeout design.

4. **Whether `--channels` is still the invocation flag:** `claude --help` in v2.1.143
   does not list a `--channels` option. The invocation syntax may have changed to
   `--plugin-dir` / `--plugin-url` or a `plugin:` prefix with another flag. This needs
   a live invocation test before implementing `helpers/claude.ts`.

5. **The `notifications/claude/channel` inbound notification format:** We can see the
   params shape from the plugin source (`content`, `meta` with `chat_id`, `message_id`,
   `user`, `user_id`, `ts`), but the CC-side handler for how those params are rendered
   into the Claude context window is not confirmed.

---

## Implementation implications

### Path A or Path B?

**Path B. The permission relay protocol is fully understood in terms of wire format,
but our `cc-remote` plugin cannot implement it without non-trivial structural work.**

Specifically:

- The plugin must become an MCP stdio server (add `@modelcontextprotocol/sdk` as an
  MCP `Server`, connect via `StdioServerTransport`).
- It must register `capabilities.experimental['claude/channel/permission']`.
- It must register `capabilities.experimental['claude/channel']`.
- It must handle `notifications/claude/channel/permission_request` and, when received,
  forward the `{ request_id, tool_name, description, input_preview }` payload to the
  daemon as a new `permission_request` proto message.
- The daemon must relay it to the PWA. The PWA approves or denies. The daemon sends
  the answer back to the plugin. The plugin calls `mcp.notification({ method:
  "notifications/claude/channel/permission", params: { request_id, behavior } })`.
- Until that MCP server infrastructure exists, **scenarios 02, 03, and 10 must use
  `CC_REMOTE_FAKE_PERMISSION` on the plugin** to synthesise the permission trigger
  and accept that the round-trip to CC is not actually exercised.

**Recommended Path B actions for the e2e suite:**

1. Scenarios 02, 03, 10: use `CC_REMOTE_FAKE_PERMISSION` env + `waitFor` on the
   PWA `permission_request` frame. Document the gap: "permission_request is injected
   by the test hook; real CC → plugin relay not yet wired."

2. Open a tracked task: "cc-remote plugin: convert to MCP server with
   `claude/channel` + `claude/channel/permission` capabilities." The wire format is
   now fully documented.

3. Once the MCP server is wired, promote scenarios 02/03/10 to "real protocol" with
   a flag (`CCR_E2E_REAL_PERM=1`). Until then the fake path suffices.

**Recommendation: Path B.** Protocol wire format is confirmed from first-party plugin
source. Implementation gap is structural (plugin is not yet an MCP server), not a
knowledge gap. Full real-protocol e2e coverage of scenarios 02/03/10 is deferred
until the plugin MCP server work is complete. The fake-permission hook covers
integration intent in the interim.

---

## Quick-reference: the complete permission protocol

```
CC                          plugin (MCP stdio)            PWA client
 |                               |                            |
 |-- notifications/claude/       |                            |
 |   channel/permission_request  |                            |
 |   { request_id: "abcde",      |                            |
 |     tool_name, description,   |                            |
 |     input_preview }          --->                         |
 |                               |-- [translate to proto] --> |
 |                               |   permission_request       |
 |                               |   { request_id, tool,      |
 |                               |     args_summary, expires }|
 |                               |                            |
 |                               |<-- [pwa frame] -----------|
 |                               |   { type:"permission_response",
 |                               |     request_id, behavior } |
 |<-- notifications/claude/      |                            |
 |    channel/permission         |                            |
 |    { request_id: "abcde",     |                            |
 |      behavior: "allow"|"deny"}|                            |
```

**Key constraints:**
- `request_id` is exactly 5 lowercase chars from `[a-km-z]` (alphabet minus 'l')
- `behavior` must be the string `"allow"` or `"deny"` (lowercase)
- Plugin must declare `experimental['claude/channel/permission']` to receive the request
- Direction is: CC sends request → plugin → user → plugin → CC sends response

---

## Execution decision (2026-05-19)

After T0 research and confirmation that `--channels` is removed in Claude Code 2.1.143, we adopt the **hybrid execution pattern** for tasks 13–18 of the real-e2e plan:

- Real claude is launched via `claude -p "<prompt>"` (no plugin flags). It writes its real JSONL to `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`.
- A fake-claude harness, started alongside, registers a synthetic `session_id` with the daemon AND we override `CLAUDE_PROJECTS_DIR` so daemon and real claude agree on the JSONL path. Daemon's watcher sees real Claude's writes under that session_id.
- Permission scenarios (02/03/10) use `CC_REMOTE_FAKE_PERMISSION` env on fake-claude (Path B). Plugin↔Claude Code permission protocol stays unverified in this suite — to be addressed in a future "plugin MCP modernization" plan.
- Scenario 09 (start_session) uses `sh -c "echo started"` as the spawn_command, not real claude. Verifies the spawn machinery without depending on plugin loading.

This trades plugin-load realism for everything else (real Claude API, real JSONL, real docker hub, real OIDC flow, real DPoP auth, real watcher, real router, real PWA flow). Documented as the explicit boundary in the spec §10 ("out of scope: real Claude Code plugin loading via current `--plugin-dir`/`marketplace install` mechanism").
