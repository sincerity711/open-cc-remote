# Spike: does `claude -p` engage the channel-permission protocol?

**Date:** 2026-05-20
**Investigator:** Claude (subagent)
**Claude Code version:** 2.1.144
**Plugin version:** `@cc-remote/plugin@0.1.0` (this repo, current `main`)
**Time spent:** ~40 minutes
**API spend:** ~$0.29 (one accidental Opus run; the 6 Haiku runs cost ~$0.13)

---

## TL;DR — Classification: **A2**

`claude --plugin-dir packages/plugin -p "..."` **loads the plugin and the plugin
registers a session with the daemon**, but Claude Code **never sends a
`notifications/claude/channel/permission_request`** to the plugin in `-p` mode,
regardless of which tool the model uses or which `--permission-mode` value is
passed. CC silently auto-allows tool calls in 2-3 ms, never consulting the channel.

Path A (real CC ↔ plugin permission relay) **is not viable in `-p` mode** with
the current 2.1.144 binary. Real-e2e scenarios that depend on permission relay
must either (a) keep using `CC_REMOTE_FAKE_PERMISSION` (Path B), or (b) invoke
real Claude in **interactive** mode with a TTY, which is harder to script.

---

## Setup

### Mock daemon

`/tmp/spike-mock-daemon.ts` (cleaned up after spike). Listens on a Unix socket,
decodes plugin frames using `packages/proto/src/codec.ts`, logs everything with
millisecond timestamps, auto-acks `register`/`bye`, and would auto-allow any
`permission_request` by replying `permission_reply { decision: "allow" }`.

Key code path (the relevant 20 lines):

```ts
sock.on("data", (chunk) => {
  for (const f of dec.push(new Uint8Array(chunk))) {
    log("FRAME-IN", JSON.stringify(f));
    if (f.type === "register" || f.type === "bye") {
      send({ type: "ack", ref: f.type });
    } else if (f.type === "permission_request") {
      send({ type: "permission_reply", request_id: f.request_id, decision: "allow" });
    }
  }
});
```

### Sandbox file

`/tmp/spike-target.txt`:

```
Hello spike target — this file is read by Claude during the permission spike.
```

### Invocation template

```bash
CC_REMOTE_SOCKET=/tmp/spike-daemon.sock claude \
  --plugin-dir /Users/i060912/SAPDevelop/channel/packages/plugin \
  --model claude-haiku-4-5 \
  [--permission-mode <mode>] [--debug-file /tmp/spike-debug.log] \
  -p "<prompt>" --output-format json --max-budget-usd 0.10
```

---

## Prompts and variations tested

| # | Prompt | Model | Permission mode | Tool model used | Daemon got `permission_request`? | `permission_denials` in result | Result |
|---|--------|-------|-----------------|-----------------|----------------------------------|--------------------------------|--------|
| 1 | "Read /tmp/spike-target.txt and tell me its first line verbatim." | (default → opus 4.7) | (none) | Read | **No** | `[]` | budget cap hit (Opus is expensive, 1 turn) |
| 2 | same | claude-haiku-4-5 | (none) | Read | **No** | `[]` | success, file content returned |
| 3 | "Run the bash command: echo hello-from-bash-spike" | claude-haiku-4-5 | (none) | Bash | **No** | `[]` | success |
| 4 | "Run the bash command: echo hello-from-bash-spike-2" | claude-haiku-4-5 | `default` (explicit) | Bash | **No** | `[]` | success |
| 5 | "Run the bash command: echo dbg-spike" | claude-haiku-4-5 | (none) + `--debug` | Bash | **No** | `[]` | success |
| 6 | "Use the Write tool to create the file /tmp/spike-write-out.txt …" | claude-haiku-4-5 | (none) + `--debug-file` | Write | **No** | `[]` | success, file created |
| 7 | "Run the bash command: echo dbg-spike-default-mode" | claude-haiku-4-5 | `default` (explicit) + `--debug-file` | Bash | **No** | `[]` | success |
| 8 | "Run the bash command: echo dbg-spike-disallow" | claude-haiku-4-5 | (none) + `--disallowedTools Bash` | (no Bash; model declined) | **No** | `[]` | model said it had no Bash tool |

### Aggregate: 8 distinct `claude` invocations → 8 plugin connections → **0 permission_request frames**

```
$ grep -c CONNECT /tmp/spike-daemon.log
8
$ grep -c '"permission_request"' /tmp/spike-daemon.log
0
```

Frame log was uniform across all 8 runs — only `register` came in, and a
`bye` was never sent either (CC tears the plugin down by closing stdio,
not by waiting for a graceful bye in `-p` mode):

```
[13:25:38.751] CONNECT
[13:25:38.759] FRAME-IN {"type":"register","session":{...,"plugin_version":"0.1.0"}}
[13:25:38.759] FRAME-OUT {"type":"ack","ref":"register"}
[13:25:38.???] DISCONNECT  (after claude -p finishes)
```

(`DISCONNECT` is logged by the mock daemon but trimmed from the slice above for
brevity. Eight CONNECT/DISCONNECT pairs, zero permission frames.)

---

## Smoking-gun evidence from `--debug-file`

Run #6 (Write tool) at `/tmp/spike-debug.log`:

```
2026-05-19T13:27:15.721Z [DEBUG] Loaded inline plugin from path: cc-remote
2026-05-19T13:27:15.787Z [DEBUG] MCP server "plugin:cc-remote:cc-remote": Starting connection with timeout of 30000ms
2026-05-19T13:27:15.801Z [DEBUG] [auto-mode] kickOutOfAutoIfNeeded applying:
                                  ctx.mode=bypassPermissions ctx.prePlanMode=undefined reason=model
2026-05-19T13:27:15.899Z [DEBUG] MCP server "plugin:cc-remote:cc-remote": Successfully connected (transport: stdio) in 114ms
2026-05-19T13:27:15.901Z [DEBUG] MCP server "plugin:cc-remote:cc-remote": Connection established with capabilities:
                                  {"hasTools":true,"hasPrompts":false,"hasResources":false,...}
2026-05-19T13:27:19.492Z [INFO]  [Stall] tool_dispatch_start tool=Write toolUseId=toolu_... permissionDecisionMs=2
2026-05-19T13:27:19.522Z [INFO]  [Stall] tool_dispatch_end tool=Write toolUseId=toolu_... outcome=ok durationMs=31
```

Two key facts:

1. **`ctx.mode=bypassPermissions`** is set by `kickOutOfAutoIfNeeded` with
   `reason=model` immediately after the plugin connects. CC's auto-mode logic
   forces `bypassPermissions` for non-interactive `-p` runs whenever the model
   is the trigger. This is internal CC behaviour, not a flag we set.

2. **`permissionDecisionMs=2`** — the permission decision took 2 ms (3 ms in
   another run). That is far too fast to involve any IPC round-trip; it
   indicates a synchronous in-process bypass.

Run #7 with `--permission-mode default` explicitly:

```
2026-05-19T13:27:46.089Z [DEBUG] [auto-mode] kickOutOfAutoIfNeeded applying:
                                  ctx.mode=default ctx.prePlanMode=undefined reason=model
2026-05-19T13:27:49.596Z [INFO]  [Stall] tool_dispatch_start tool=Bash toolUseId=... permissionDecisionMs=3
```

Even with `--permission-mode default`, Bash dispatch decides in 3 ms with no
plugin notification. So **`-p` short-circuits permission dispatch even outside
`bypassPermissions`** — the channel-permission relay is simply not engaged in
non-interactive mode.

Note: capability negotiation succeeded — `Connection established with
capabilities: {"hasTools":true,...}`. The full experimental capabilities
(`claude/channel`, `claude/channel/permission`) are advertised by our plugin
and presumably visible to CC; CC chose not to use them in `-p` mode anyway.

---

## Classification: A2

> **A2**: claude executes the tool without consulting plugin (auto-allow or
> terminal-only permission path; plugin gets the `register` frame but no
> `permission_request` even when tool is used).

This matches our observation exactly — 8 different invocations covering Read,
Bash (twice), Write, and a `default`-mode forced run all produced `register`
only. The plugin's permission relay code (`packages/plugin/src/permission.ts`)
is not exercised in `-p` mode at all.

Sub-classification: this is the **terminal-only permission path** flavour of
A2. The CC debug output's wording (`kickOutOfAutoIfNeeded`,
`bypassPermissions`, `permissionDecisionMs=2`) suggests CC is treating
non-interactive mode as already-bypassed, which is consistent with the
documentation in `claude --help` for `-p`:

> Print response and exit … workspace trust dialog is skipped when Claude is
> run in non-interactive mode … Settings files that fail validation are
> silently ignored in this mode.

A non-interactive run can't show a terminal permission prompt to a human, and
CC apparently does not fall back to the channel-permission MCP path either —
it simply allows the tool. Whether this is intentional or a missing feature
in 2.1.144 is unknown.

---

## Implications for the e2e plan

### What `helpers/claude.ts` should invoke

The current draft helper that runs `claude --plugin-dir <path> -p "<prompt>"`
is **fine for non-permission scenarios** (Read events appear in the JSONL,
register flows through the plugin, the daemon's watcher sees content). It is
**not fine for permission scenarios**: the round-trip through plugin → daemon
→ PWA → daemon → plugin → CC will never trigger from a `-p` run.

Concrete recommendation:

- Keep `helpers/claude.ts` using `claude --plugin-dir <path> -p "<prompt>"` for
  scenarios 13–18 (chat, JSONL streaming, idle/task-complete frames, history,
  kill, etc.). All of those work today.
- For scenarios 02 / 03 / 10 (permission allow / deny / expire), **do not
  attempt to drive the real channel relay from a `-p` invocation**. Either:
  - **Stay on Path B** (use fake-claude with `CC_REMOTE_FAKE_PERMISSION` to
    inject the frame) — exactly as `docs/superpowers/research/channel-permission-protocol.md`
    recommended on 2026-05-19. This spike confirms that recommendation is
    still correct; nothing has changed in 2.1.144.
  - Or, if real-CC permission coverage is required, drive an interactive PTY
    (`script`/`expect`/`node-pty`) with `claude` (no `-p`), wait for the model
    to call a permission-required tool, and consume the
    `permission_request` MCP notification on the plugin side. This is
    significantly more complex and hasn't been validated.

### Scenario 02 prompt suggestion

If/when interactive-PTY mode is implemented, a reliable trigger prompt is:

> "Use the Write tool to create the file /tmp/ccr-perm-target.txt with the
> single line content: cc-remote-test"

Haiku reliably tool-calls Write here (verified in run #6). Bash is also
reliable (runs #3, #4, #5, #7 all called Bash on first turn).

For **`-p`-mode** scenarios that just need any tool-use event in the JSONL,
the read-file prompt — *"Read /tmp/spike-target.txt and tell me its first
line verbatim"* — is the cheapest cleanest option (~$0.045 with Haiku, single
turn, no permission noise).

### Haiku vs Sonnet for tool-calling reliability

- **Haiku (`claude-haiku-4-5`) is reliable** for the prompts tested. Every
  Haiku run that asked for Bash/Read/Write resulted in the requested tool
  call on turn 1. No need to upgrade to Sonnet for the e2e suite.
- The default model when no `--model` is passed is **Opus 4.7**, which is
  expensive ($0.16 in our run #1 before hitting the budget cap). The e2e
  helper **must** pass `--model claude-haiku-4-5` explicitly.

### Cost guardrails for the e2e suite

- Tool-calling prompts on Haiku cost ~$0.01–0.05 per scenario.
- Always pass `--max-budget-usd 0.10` (or lower) per `claude` invocation as a
  belt-and-braces guard.
- The first run after a cold cache pays a cache-creation tax (~$0.045 in
  run #2); subsequent runs in the same session are ~$0.01 due to cache reads.

### Surprises for the plan author

1. **CC default model in `-p` is Opus 4.7, not Haiku.** A scenario without
   `--model` will spend ~$0.16 per failure during iteration. Always set the
   model explicitly. (See run #1.)
2. **`--permission-mode default` does not restore the prompt path in `-p`.**
   The flag is accepted but the dispatch still completes in 2–3 ms without
   consulting the plugin. Don't expect this flag to "make permissions real"
   in non-interactive mode.
3. **CC's debug output explicitly logs `ctx.mode=bypassPermissions reason=model`**
   for `-p` runs without the user setting any flag. This is internal
   auto-mode logic in `kickOutOfAutoIfNeeded`. Worth referencing in the spec
   §10 boundary statement.
4. **Plugin loads even when daemon isn't reachable would fail** (the plugin
   exits with code 1 if `connectDaemon` fails). The e2e helper must start the
   daemon (or mock daemon) before launching `claude`. This isn't new but is
   worth restating: there is no graceful degradation path.

---

## What this does NOT settle

- Whether the channel-permission relay works in **interactive** mode (no `-p`).
  Strong prior evidence from the official Telegram/Discord/iMessage plugins
  says it does, but this spike did not test it. A follow-up spike with a PTY
  (or `script -q`) would be needed to confirm.
- Whether Claude Code 2.1.145+ changes this behaviour. Watch CC release notes
  for "channel permission" mentions.
- Whether `--input-format stream-json` (which keeps the process alive across
  multiple model turns) re-enables the relay. Untested. Plausibly the same
  short-circuit applies, but worth a 5-minute follow-up if real-CC permission
  coverage becomes critical.

---

## Files referenced

- Spike scripts (cleaned up post-spike): `/tmp/spike-mock-daemon.ts`,
  `/tmp/spike-target.txt`
- Logs (cleaned up post-spike): `/tmp/spike-daemon.log`,
  `/tmp/spike-claude-{1..8}.{stdout,stderr}`, `/tmp/spike-debug{,-2,-3}.log`
- Plugin source (unchanged): `packages/plugin/src/index.ts`,
  `packages/plugin/src/permission.ts`
- Earlier protocol research: `docs/superpowers/research/channel-permission-protocol.md`

---

## Update 2026-05-20 (later) — re-spike with isolated settings

### Why re-spike

The first spike's `[auto-mode] kickOutOfAutoIfNeeded applying: ctx.mode=bypassPermissions reason=model` log line was likely tainted by the investigator's `~/.claude/settings.json`, which contains:

```json
"permissions": { "defaultMode": "bypassPermissions", "deny": ["WebSearch"] },
"skipDangerousModePermissionPrompt": true
```

That makes the `bypassPermissions` mode a property of *the operator's environment*, not of `-p` mode itself. The first spike's A2 verdict had to be re-validated with a clean settings stack.

### Mechanism for isolating user settings

Confirmed via `claude --help` (Claude Code 2.1.144):

```
--setting-sources <sources>  Comma-separated list of setting sources to load (user, project, local).
```

Source: `claude --help 2>&1 | grep setting-sources` — the flag accepts a subset of `{user, project, local}`. Passing `--setting-sources project,local` excludes `user` (i.e., `~/.claude/settings.json`).

Other candidates considered and rejected:

- `--settings <path>` only **adds** an additional settings file; it does not replace the user/project/local stack. Not a clean isolation mechanism on its own.
- `--bare` is broader (skips hooks, LSP, plugin sync, attribution, auto-memory, CLAUDE.md auto-discovery) and changes auth behaviour. The help text does not say it skips user settings, and it conflicts with `--plugin-dir`'s expected behaviour. Not the right tool.
- `CLAUDE_CONFIG_DIR` env var is not documented in `claude --help`. Untested in the re-spike.
- A `--no-settings` flag does not exist in 2.1.144.

`--setting-sources project,local` is the supported, documented mechanism.

### Re-spike confirmation that isolation worked

Run with `--setting-sources project,local --debug-file /tmp/spike2-debug-2.log` and **no** `~/.claude` user settings in scope:

```
[DEBUG] Broken symlink or missing file encountered for settings.json at path: /private/tmp/.claude/settings.json
[DEBUG] Broken symlink or missing file encountered for settings.json at path: /private/tmp/.claude/settings.local.json
[DEBUG] [auto-mode] kickOutOfAutoIfNeeded applying: ctx.mode=default ctx.prePlanMode=undefined reason=model
[INFO]  [Stall] tool_dispatch_start tool=Bash toolUseId=... permissionDecisionMs=5
```

Compare with the first spike (user settings active): `ctx.mode=bypassPermissions`. Now: **`ctx.mode=default`**. Isolation is real and effective. The `bypassPermissions` from the first spike was indeed the user's `defaultMode: "bypassPermissions"` leaking through.

Note: a `Watching for changes in setting files /Users/i060912/.claude/settings.json...` line still appears even with `--setting-sources project,local`. The user file is *watched* for changes but its values are *not loaded* — the effective `ctx.mode=default` proves that.

### Re-spike results

Two `claude` invocations with `--setting-sources project,local`, mock daemon at `/tmp/spike2-daemon.sock`, model `claude-haiku-4-5`:

| # | Prompt | Tool used | `ctx.mode` | `permissionDecisionMs` | `permission_request` to plugin? | `permission_denials` |
|---|--------|-----------|-----------|------------------------|----------------------------------|---------------------|
| R1 | "Read /tmp/spike2-target.txt and tell me its first line verbatim." | Read | `default` | 5 ms | **No** | `[]` |
| R2 | "Run the bash command: echo hello-from-clean-spike" | Bash | `default` | 5 ms | **No** | `[]` |

Final tally: 2 plugin connections, **0 permission_request frames**, both runs succeeded.

```
$ grep -c CONNECT /tmp/spike2-daemon.log
2
$ grep -c '"permission_request"' /tmp/spike2-daemon.log
0
```

### Updated classification: **A2 confirmed**

Even with `ctx.mode=default` (the standard prompting mode, not bypass), `claude -p` dispatches Bash and Read in 5 ms with no plugin notification. The original A2 verdict stands; the user's tainted settings were a confounder for the *underlying mode label* but not for the *outcome* — the plugin never receives a `permission_request` notification in `-p` mode regardless of whether the effective mode is `bypassPermissions` or `default`.

What this almost certainly means: the channel-permission relay is wired into the *interactive* permission UI in CC 2.1.144. `-p` mode skips the interactive permission UI by design (per `claude --help`'s `-p` blurb: "workspace trust dialog is skipped when Claude is run in non-interactive mode"). It appears the channel relay is part of the same skipped path. The plugin's `notifications/claude/channel/permission_request` handler will only fire from a TTY-attached `claude` process.

### Updated recommendation for `helpers/claude.ts`

For deterministic, settings-independent e2e behaviour, the helper should invoke:

```bash
claude \
  --plugin-dir <plugin-path> \
  --model claude-haiku-4-5 \
  --setting-sources project,local \
  --max-budget-usd 0.10 \
  -p "<prompt>" \
  --output-format json
```

Setting `--setting-sources project,local` makes the test independent of whatever the developer has in their `~/.claude/settings.json` (e.g., `bypassPermissions`, custom `deny` rules, custom model overrides, custom env injection). This is essential for CI and for running the suite on different developer machines.

### Path A still unviable for `-p` — Plan B for permission scenarios

The earlier conclusion stands: **scenarios 02 / 03 / 10 (permission allow / deny / expire) cannot use `claude -p` to drive a real channel-permission round-trip.** Use `CC_REMOTE_FAKE_PERMISSION` on fake-claude (Path B) for those scenarios.

For chat / JSONL / kill / start_session / idle / task_completed scenarios (13–18), `claude -p` with `--setting-sources project,local` works fine and gives a real, settings-independent CC integration.

If real-CC permission coverage is later required, the only option is interactive mode driven via PTY (`script -q`, `node-pty`, or similar). Untested but consistent with the "channel relay needs the interactive permission UI" hypothesis.

### Cost of the re-spike

2 Haiku invocations: ~$0.045 + ~$0.0094 ≈ $0.054. Cumulative spike spend ~$0.34.

---

## Update 2026-05-20 (third spike) — tmux interactive **flips A2 → A1**

### Summary

**Path A is viable.** With the right hidden flags, real Claude Code 2.1.144 in
an interactive tmux session **does** route permission requests through the
plugin's `claude/channel/permission` capability, the plugin's daemon-client
sees `permission_request` proto frames, and the daemon's reply is honored.
The `-p`-mode dead-end was not just about the TTY — there are also two
mandatory CLI flags (`--channels` / `--dangerously-load-development-channels`)
that aren't in `claude --help` output but are required for channel
notifications to fire at all. The `--channels plugin:cc-remote@local` pattern
documented in the original v1 plan was correct in spirit; we just hadn't
re-discovered it after the PMCP rework.

### Workspace-trust dialog

Yes, the trust dialog blocks startup the first time `claude` is run inside
`/private/tmp`. Programmatic bypass: send `Enter` once.

```bash
tmux send-keys -t <session> Enter
```

After that, CC writes the trust decision to its trust store and subsequent
runs in the same cwd skip the dialog. (The dialog text: *"Quick safety
check: Is this a project you created or one you trust?"* → 1. Yes / 2. No.)

### Smoking-gun debug line that unblocked the spike

In an interactive run **without** `--channels`, even though the plugin
connected and registered MCP capabilities including
`claude/channel/permission`, the debug log says:

```
[DEBUG] MCP server "plugin:cc-remote:cc-remote":
        Channel notifications skipped: server plugin:cc-remote:cc-remote
        not in --channels list for this session
```

CC requires the operator to **explicitly opt-in** which MCP servers can
receive channel notifications, even after capability negotiation succeeds.
The `--channels` flag is hidden but errors helpfully when invoked
incorrectly: `claude --channels cc-remote` returns

```
--channels entries must be tagged: cc-remote
  plugin:<name>@<marketplace>  — plugin-provided channel (allowlist enforced)
  server:<name>                — manually configured MCP server
```

So entries must be tagged `plugin:` or `server:`. With `--plugin-dir`
(inline load), CC refuses to pair `--channels plugin:cc-remote@local`:

```
Channel notifications skipped: you asked for plugin:cc-remote@local
but the installed cc-remote plugin is from inline
```

i.e., **`--plugin-dir`'s "inline" loading is incompatible with channels.**
The plugin must be loaded as an MCP server via `--mcp-config` (a JSON file
mapping `cc-remote` to a `command/args` invocation), then tagged
`server:cc-remote` in `--channels`. And for non-allowlisted servers (which
`cc-remote` is), pass `--dangerously-load-development-channels
server:cc-remote`, which prompts a one-time terminal confirmation.

### Working invocation

MCP config (`/tmp/spike3-mcp.json`):

```json
{
  "mcpServers": {
    "cc-remote": {
      "command": "bun",
      "args": ["run", "/Users/i060912/SAPDevelop/channel/packages/plugin/src/index.ts"]
    }
  }
}
```

Launch:

```bash
tmux new-session -d -s ccr -x 220 -y 50
tmux send-keys -t ccr "ANTHROPIC_AUTH_TOKEN=PROXY_MANAGED \
  ANTHROPIC_BASE_URL=http://127.0.0.1:5000 \
  CC_REMOTE_SOCKET=/tmp/spike3-daemon.sock \
  claude \
    --mcp-config /tmp/spike3-mcp.json \
    --dangerously-load-development-channels server:cc-remote \
    --model claude-haiku-4-5 \
    --setting-sources project,local \
    --debug-file /tmp/cc-debug.log" Enter
sleep 6
tmux send-keys -t ccr Enter   # accept dev-channels confirmation
sleep 6
tmux send-keys -t ccr "Run bash: rm -rf /tmp/nonexistent-xyz-spike" Enter
```

### Frames observed

Mock daemon log:

```
[13:50:09.431] LISTEN /tmp/spike3-daemon.sock
[13:50:16.264] CONNECT
[13:50:16.346] FRAME-IN  {"type":"register", ...}
[13:50:16.346] FRAME-OUT {"type":"ack","ref":"register"}
[13:50:57.238] FRAME-IN  {"type":"permission_request",
                          "request_id":"rfcqc",
                          "tool":"Bash",
                          "args_summary":"{\"command\":\"rm -rf /tmp/nonexistent-xyz-spike\",
                                            \"description\":\"Remove the /tmp/nonexistent-xyz-spike directory…\"}",
                          "expires_at":1779198957238}
[13:50:57.238] FRAME-OUT {"type":"permission_reply","request_id":"rfcqc","decision":"allow"}
[13:51:17.279] DISCONNECT
```

CC debug log corroboration:

```
[DEBUG] MCP server "cc-remote": Channel notifications registered
[DEBUG] executePermissionRequestHooks called for tool: Bash
[DEBUG] MCP server "cc-remote": notifications/claude/channel/permission: rfcqc → allow (matched pending)
[INFO]  [Stall] tool_dispatch_start tool=Bash permissionDecisionMs=59
```

Observations from the frame:

- **`request_id="rfcqc"` matches the `[a-km-z]{5}` regex** confirmed in
  `channel-permission-protocol.md`. Five lowercase letters from the
  alphabet minus 'l'.
- **`permissionDecisionMs=59`** — 59 ms round-trip (plugin → daemon →
  plugin → CC). Non-channel path is 2–4 ms. Well within e2e budgets.
- **`args_summary` for Bash is the JSON-stringified `{command, description}`
  object**, not a plain string. Tests should `JSON.parse` or substring-match.
  The plugin's `permission.ts` forwards `params.input_preview ||
  params.description` from the MCP notification verbatim; whichever branch
  fired here produced JSON. Consistent with CC sending `input_preview` as
  a stringified object.

### Final classification: **A1**

Path A works in tmux interactive with the right flags. Specifically:

1. Plugin must be loaded via `--mcp-config <file>`, NOT `--plugin-dir`.
   `--plugin-dir`'s "inline" plugins are explicitly excluded from the
   channels allowlist gate.
2. `--dangerously-load-development-channels server:<name>` is required to
   register the server in CC's per-session channel allowlist.
3. The user must press Enter once at the dev-channels confirmation prompt
   (text: *"WARNING: Loading development channels … 1. I am using this
   for local development / 2. Exit"*).
4. Workspace-trust dialog: one-time press Enter on first run in a cwd.
5. The model needs to call a tool that CC considers permission-gated. Read
   is always allowed. Plain `echo` Bash is allowed. `rm -rf` triggers the
   gate. `Write` to new paths triggers it.

### Updated recommendation for `helpers/claude.ts`

Tests split into two paths:

**Non-permission scenarios (chat, JSONL, kill, history, idle/task_completed)** —
unchanged from spike 2:

```bash
claude \
  --plugin-dir packages/plugin \
  --model claude-haiku-4-5 \
  --setting-sources project,local \
  --max-budget-usd 0.10 \
  -p "<prompt>" --output-format json
```

**Permission scenarios (02 / 03 / 10)** — Path A via tmux:

```bash
# Pre-step: write mcp-config (one per test):
cat > $TMPDIR/ccr-mcp.json <<EOF
{ "mcpServers": { "cc-remote": {
    "command": "bun",
    "args": ["run", "<repo>/packages/plugin/src/index.ts"]
} } }
EOF

# tmux harness:
tmux new-session -d -s $S -x 220 -y 50
tmux send-keys -t $S "ANTHROPIC_AUTH_TOKEN=$TOKEN ANTHROPIC_BASE_URL=$BASE \
  CC_REMOTE_SOCKET=$SOCK \
  claude \
    --mcp-config $TMPDIR/ccr-mcp.json \
    --dangerously-load-development-channels server:cc-remote \
    --model claude-haiku-4-5 \
    --setting-sources project,local \
    --max-budget-usd 0.20" Enter
sleep 4 && tmux send-keys -t $S Enter   # dev-channels confirmation
sleep 2 && tmux send-keys -t $S Enter   # workspace-trust (cold cwd only)
tmux send-keys -t $S "Use the Write tool to create $TARGET with content 'foo'" Enter
# Then poll the daemon for permission_request, reply via your fixture, capture-pane to verify CC continued.
```

### What the e2e plan author needs to know

1. **`--plugin-dir` is fundamentally insufficient for permission tests.** Use
   `--mcp-config` instead. Two separate loading mechanisms, different
   capability scopes.
2. **`--channels` and `--dangerously-load-development-channels` are hidden**
   (not in `claude --help`). Document them in the helper's source so future
   maintainers know why they're there.
3. **The dev-channels confirmation is interactive** — there's no
   `--yes-i-am-developing` env var visible in 2.1.144. Drive via
   `tmux send-keys`. Keep an eye on future CC versions for an env override.
4. **Permission gate is per-command, not per-tool.** `echo foo` does not
   prompt; `rm -rf <path>` does (any path, even nonexistent); `Write` to a
   new file does. Pick prompts accordingly.
5. **`request_id` is `[a-km-z]{5}`** — matches the existing regex in
   `channel-permission-protocol.md`. Tests can assert this format.
6. **`args_summary` for Bash is JSON-stringified `{command, description}`,**
   not a plain string. Tests should adjust.
7. **Auth env**: with `--setting-sources project,local`, the user's
   `~/.claude/settings.json` is excluded — that's where this developer's
   `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_BASE_URL` live. Helper must inject
   those into `process.env` before spawn. CI can use `ANTHROPIC_API_KEY`.
8. **Cost**: third spike spent ~$0.10 across ~3 Haiku turns. Permission
   round-trip itself costs nothing (no extra API calls). A typical
   permission scenario is 15–25 s wall time, ~$0.04 per run.

### Plan B status

Plan B (fake-claude `CC_REMOTE_FAKE_PERMISSION` injection) remains the
**preferred path for fast unit / fake-only e2e tests**. Path A's tmux
choreography is more expensive (cold-start ~10s for trust + dev-channels
prompts, real Anthropic API). Use Path A for *coverage* (scenarios 02/03/10
promoted to "real" mode); keep Plan B for *iteration* / regression on every
commit.

### Files referenced (third spike, all cleaned up)

- `/tmp/spike3-mock-daemon.ts`, `/tmp/spike3-mcp.json`,
  `/tmp/spike3-daemon.log`, `/tmp/spike3-debug-{1..5}.log`
- Plugin source unchanged.
- Earlier protocol research:
  `docs/superpowers/research/channel-permission-protocol.md` — the
  `--channels plugin:cc-remote@local` invocation documented there
  (pre-PMCP-rework v1) was correct. The PMCP-rework spec correctly
  identified that `--plugin-dir` doesn't pair with channels. This spike
  found the workaround: `--mcp-config` +
  `--dangerously-load-development-channels server:cc-remote`.
