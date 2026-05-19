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
