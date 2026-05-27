# Local debug environment

How to spin up a local demo where the **PWA → hub → daemon → CC** chain runs
end-to-end against a real Claude Code TUI, plus the gotchas we hit while
debugging the AskUserQuestion remote-relay (2026-05-27).

> **TL;DR — when AskQuestionSurface won't render in PWA**, jump straight to the
> [Debug checklist](#debug-checklist-pwa-doesnt-show-askquestionsurface)
> below. The `docker compose exec hub grep` step on row 5 has bitten us once
> and will bite us again.

---

## 1. Bring up the demo

```bash
./tools/demo-channel.sh up
```

This script (read it before changing anything — it's the source of truth):

| Component | What | Where |
|---|---|---|
| `hub` (docker) | Frame router + IAS glue | `127.0.0.1:17745` (host) → `7745` (container) |
| `fake-ias` (docker) | OIDC stub for PWA login | `127.0.0.1:17770` → `7770` |
| `daemon` (host bun) | jsonl tail + hook socket | `/tmp/cc-remote-demo/daemon.sock` |
| `pwa` (host vite dev) | React app with `VITE_HUB_URL=ws://localhost:17745` | `http://localhost:15173` |
| `claude` (tmux: `demo-claude`) | Real CC bound to `cc-remote` channel | cwd `/private/tmp/cc-remote-demo` |

Open `http://localhost:15173/` in any browser, click **Sign in**, you're paired.

`tmux attach -t demo-claude` to talk to CC; `← cc-remote` lines are PWA-driven
prompts.

## 2. AskUserQuestion remote relay — how it actually works

Two distinct rendering paths land on the PWA. Confusing them costs hours.

### Path A — interactive picker (for live answers)

```
CC PreToolUse hook (.claude/hooks/ask-user-relay.ts)
  └─ stdin from CC: { tool_input.questions, session_id }
  └─ daemon.sock — frame: ask_user_question_request
daemon (sessions.getByClaudeSessionId)
  └─ hub.send(ask_user_question_request)
hub router.ts case "ask_user_question_request"
  └─ pwaReg.broadcast
PWA useHub.ts case "ask_user_question_request" → pendingQuestions[]
PWA RealApp.tsx → <AskQuestionSurface>          ← clickable picker
```

Submit flows the answer back through the same hops, hook stdout emits
`{permissionDecision:"deny", permissionDecisionReason:"...Q1: <label>..."}`,
CC treats the reason as a synthesized tool_result, the TUI picker **never**
renders.

### Path B — timeline tool card (post-hoc replay)

```
~/.claude/projects/<encoded-cwd>/<session>.jsonl — assistant tool_use blob
  └─ daemon tail → ClaudeCodeAdapter
  └─ proto/from-claude-code.ts blockType==="tool_use"
  └─ TOOL_CALL_CHUNK { toolCallName:"AskUserQuestion", delta:<input JSON> }
hub broadcast → PWA mergeTimeline → ToolCard
```

That's the gray-background `<pre>` JSON card with `Active`/`Success` badge.
It's history rendering. **The interactive picker is path A.**

## 3. Hook installation — non-obvious

CC must launch with `--setting-sources project,local` so it reads
`${cwd}/.claude/settings.json`. demo-channel.sh does this in the spawn line.

But the script does **not** auto-create those files. Manual placement:

```text
/private/tmp/cc-remote-demo/
├── .claude/
│   ├── settings.json         ← PreToolUse matcher for AskUserQuestion
│   └── hooks/
│       └── ask-user-relay.ts ← copy from repo .claude/hooks/
```

`settings.json` template (note the hard-coded socket env):

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "AskUserQuestion",
      "hooks": [{
        "type": "command",
        "command": "CC_REMOTE_SOCKET=/tmp/cc-remote-demo/daemon.sock $CLAUDE_PROJECT_DIR/.claude/hooks/ask-user-relay.ts",
        "timeout": 350000
      }]
    }]
  }
}
```

**TODO**: roll this provisioning into `demo-channel.sh` so the demo dir
self-bootstraps.

### Two timing traps

1. **CC loaded settings.json once at startup** — if you put the hook config
   in *after* CC was already running, the hook never attaches. Fix: kill the
   `claude` process, re-launch with `--resume <id>`.
2. **`--resume` writes a new jsonl filename** — daemon's old watcher is bound
   to the previous filename, so the *first* AskUserQuestion after resume hits
   `daemon: ask_user_question_request — no session for claude_session=<id>`.
   The plugin re-registers on the next tick and watcher binds the new jsonl;
   the second call works. This is racy and worth fixing — not yet.

## 4. Debug checklist (PWA doesn't show AskQuestionSurface)

Run these in order. Stop at the first failing one — that's your culprit.

| # | Check | Pass condition |
|---|---|---|
| 1 | `ls /private/tmp/cc-remote-demo/.claude/{settings.json,hooks/ask-user-relay.ts}` | both files exist, `ask-user-relay.ts` is `+x` |
| 2 | `ps -p <claude-pid> -o lstart` vs `stat -f %SB .../.claude/settings.json` | CC start time **before** settings.json creation? Then CC has stale config — restart it |
| 3 | When AskUserQuestion fires in TUI: `ps ax \| grep ask-user-relay` | hook child process exists for the duration of the question |
| 4 | `tail /tmp/cc-remote-demo/daemon.log` | no `ask_user_question_request — no session for claude_session=...` lines (those mean daemon doesn't recognize CC's session id) |
| 5 | `docker compose exec hub sh -c 'grep -c ask_user_question /app/packages/hub/src/router.ts'` | returns `6`. Returns `0` ⇒ **hub image drift** (see §5) |
| 6 | `lsof -iTCP:17745 -sTCP:ESTABLISHED` while PWA tab open | shows your browser's connection alongside daemon's |
| 7 | Use `tools/debug-pwa-ws-trace.ts` (or a similar playwright probe) to record `framereceived` on the PWA WS | should see `ask_user_question_request` arrive when CC fires the tool |

If 1-7 all pass and surface still doesn't render — the bug is in PWA reducer
or render gate (`useHub.ts` case `ask_user_question_request`, `RealApp.tsx`
`pendingQuestions` consumption). Drop a `console.log` and refresh.

### Important timing fact about hub broadcast

`pwaReg.broadcast` does **not** queue or replay frames. If the hook fires when
no PWA is connected, `ask_user_question_request` is broadcast to zero
listeners and lost. Hook then waits 5 minutes, daemon's expires_at timer
fires, hook emits `expired` fallback. **Open the PWA tab first, then trigger
AskUserQuestion** — otherwise the test will appear broken.

## 5. Hub Docker image drift (the 2026-05-27 footgun)

The hub container is built from `e2e-real/fixtures/hub.dockerfile`, which
copies `packages/hub/src/` at image-build time. After you add a new
daemon-to-hub frame type (e.g., `ask_user_question_request`), the running
container still serves **old code** until you rebuild — and the symptom is
silent: hub's router falls into the default switch case, no log, daemon's
frame is dropped on the floor.

Decisive check (run this any time you suspect daemon→hub→PWA breakage):

```bash
# repo
grep -c "ask_user_question" packages/hub/src/router.ts          # → 6

# container (must match)
docker compose exec hub sh -c \
  'grep -c "ask_user_question" /app/packages/hub/src/router.ts' # → 6
```

A mismatch means your container is stale.

### Permanent fix (when network reaches docker.io)

```bash
cd e2e-real
docker compose build hub
docker compose up -d hub
```

### Hot-patch (when registry is unreachable, like behind SAP proxy)

```bash
docker cp packages/hub/src/. e2e-real-hub-1:/app/packages/hub/src/
docker cp packages/proto/src/. e2e-real-hub-1:/app/packages/proto/src/
docker compose restart hub
```

**Caveat**: hot-patch lives in the container's writable layer. It survives
`docker compose restart` but is destroyed by `docker compose down -v` or
`docker rm`. Re-apply after every full teardown.

## 6. Useful one-liners

```bash
# Watch hook activity in real time
watch -n 0.5 'ps ax | grep ask-user-relay | grep -v grep'

# Tail daemon log
tail -f /tmp/cc-remote-demo/daemon.log

# Tail hub stdout
docker compose logs -f hub

# Check PWA WS auth state
lsof -iTCP:17745 -sTCP:ESTABLISHED | grep -i 'edge\|chrome\|firefox'

# Force CC restart (preserve session history)
kill <claude-pid>
tmux send-keys -t demo-claude \
  "ANTHROPIC_AUTH_TOKEN=PROXY_MANAGED ANTHROPIC_BASE_URL=http://127.0.0.1:5000 \
   claude --resume <session-id> \
   --mcp-config /tmp/cc-remote-demo/mcp-config.json \
   --dangerously-load-development-channels server:cc-remote \
   --model claude-haiku-4-5 \
   --setting-sources project,local \
   --allowedTools 'mcp__cc-remote__reply'" Enter
```

## 7. Upstream issues to watch

- **anthropics/claude-code#59245** — RFC for native channel notification for
  AskUserQuestion. When this lands, the hook workaround in
  `.claude/hooks/ask-user-relay.ts` becomes obsolete; replace with a
  plugin-side handler. Daemon/hub/PWA wire frames already mirror the
  proposed shape, so the cutover is mechanical.
- **anthropics/claude-code#58463** — jsonl flush behavior. Already fixed in
  CC 2.1.139+: tool_use blocks are flushed immediately, not held until
  tool_result arrives. (Earlier confusion about "AskUserQuestion never lands
  in jsonl" was caused by this — and by hooks short-circuiting tool_use to
  deny, which **does** suppress the tool_use jsonl entry.)
