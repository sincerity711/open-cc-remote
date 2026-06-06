# TODO

Pending work — consolidated record. Update entries inline as items move from pending → done.

## Demo / start_session next steps (surfaced 2026-05-22)

Hit while trying to spawn a new session (`~/SAPDevelop/obsidian-kg`) from the PWA in the demo. Worked around at the demo level; underlying issues remain.

1. ~~**`cc-remote pair` clobbers config.json**~~ — `packages/daemon/bin/cc-remote.ts:56` rewrites the file down to `{daemon_id, hub_url}` only, dropping `allow_start`, `allowed_cwd_prefix`, `spawn_command`, `idle_window_ms`. Demo script worked around by re-emitting after pair, but the CLI should preserve / merge. **DONE** — pair now reads + merges existing config.json (atomic tmp+rename).
2. ~~**`spawn_command` default is dead**~~ — `packages/daemon/src/config.ts:46` defaults to `claude --channels plugin:cc-remote@local`, which is the pre-2.1 CLI interface. Anyone using the daemon without overriding gets a silent no-op. Either remove the default (require explicit) or update to the working `--mcp-config + --dangerously-load-development-channels` form. **DONE** — default removed; `spawn_command` now `string | undefined`. start_session rejects with reason `spawn_command_unset` (surfaced via #3).
3. ~~**PWA new-session has no error feedback**~~ — daemon rejects (`allow_start=false`, cwd outside prefix, tmux spawn error) only emit to `daemon.log`; PWA shows nothing. Add an error frame back to PWA + a toast on rejection. **DONE** — new `start_session_rejected` proto frame (daemon→hub→PWA) with structured `reason`; PWA's useHub stores per-daemon `startSessionErrors`; HomeScreen shows inline alert with reason + message + dismiss button.
4. ~~**start_session won't create missing cwd**~~ — `tmux new-session -c <missing-dir>` fails silently. Either daemon `mkdir -p` the cwd before spawn (gated by `allowed_cwd_prefix`) or surface the error per #3. **DONE** — `precheckStartSession` enforces prefix-then-mkdir order; mkdir failure becomes `mkdir_failed` reject reason.
5. ~~**`mcp-config.json` is co-located with demo state**~~ — `spawn_command` references `/tmp/cc-remote-demo/mcp-config.json`. For non-demo use the daemon should ship its own MCP config (or generate one in its state dir) rather than depend on a sibling tool's path. **DONE** — daemon's `ensureMcpConfig` idempotently writes `<state_dir>/mcp-config.json` on startup using `process.execPath` for `bun` and the resolved plugin entry; demo script can drop its hand-written copy.
6. ~~**Init CLI for daemon config**~~ — user wants a `cc-remote init` (or similar) that writes a sane config.json with `allow_start`, `allowed_cwd_prefix=$HOME`, working `spawn_command`. Avoids the hand-edit dance the demo currently does. (Captures the user's "config 以后做初始化的 cli" remark.) **DONE** — `cc-remote init [--state-dir] [--hub] [--force]` writes a starter config.json (no `spawn_command` — paired with #2's explicit-required behavior); refuses to clobber without `--force`.
7. ~~**Plugin auto-reconnect on daemon restart**~~ — `packages/plugin/src/index.ts:35` does `process.exit(0)` in `daemon.onClose`. Any daemon restart (config change, crash, upgrade) kills the plugin → Claude loses its MCP server → user must manually restart Claude. Plan A: plugin holds a backoff-reconnect loop, re-sends `register` with the same `session_id` on reconnect, keeps Claude's stdio transport alive throughout. Caveat: daemon's `bindJsonl` only watches for new files post-register; on re-register it'll miss the existing JSONL — needs daemon to either (a) accept `claude_session_id` from the register frame and skip bind, or (b) `bindJsonl` to detect already-written files. Either way the plugin should remember the bound `claude_session_id` from the first register and pass it on subsequent ones. **DONE** — daemon emits new `bind_resolved` frame after binding; plugin caches `claude_session_id` on its in-memory `registeredSession`; on re-register the daemon sees a non-null `claude_session_id` and skips bindJsonl, starting the watcher directly (with a `bindJsonl` fallback if the JSONL file is unexpectedly missing).

## Settings page gaps (surfaced 2026-05-23) — DONE

Spec at `docs/superpowers/specs/2026-05-23-settings-page-design.md`. Plan at `docs/superpowers/plans/2026-05-23-settings-page-plan.md`. Tagged `plan-settings-page`.

1. ~~**Pair-code feature missing**~~ — DONE. `POST /pair/issue` route + `usePairing` hook + countdown UI + copy-as-`cc-remote pair <code>` shipped.
2. ~~**Loading/error tri-state broken**~~ — DONE. `Resource<T>` discriminated union with per-section retry; top error banner removed.
3. ~~**Daemon online status invisible**~~ — DONE. `GET /daemons` includes live `connected` from router's in-memory map; `<StatusDot>` renders `aria-label="online|offline"`.
4. ~~**Channel-based notifications (separate future spec)**~~ — **DONE** as `plan-push-topics-*`. See "Plan completed (2026-05-26)" below.

## e2e-real OIDC chain regression (surfaced and fixed 2026-05-23)

`loginAndConnect` (`e2e-real/helpers/pwa-client.ts`) was broken since commit `228d3de` (oidc-provider subprocess replaces hand-rolled mock). The new chain inserts `/interaction/{uid}` and `/authorize/{uid}` consent hops between `/authorize` and `/auth/callback`. Most scenarios silently passed because oidc-provider's middleware auto-completes interactions on first hit, but `15-multi-pending.test.ts` second loginAndConnect failed when the test client only followed 3 fixed hops. Fixed by replacing the 3-hop helper with a generic `followChain` that follows up to 10 redirects and stops at the bearer fragment.

## Pair-flow hardening (surfaced 2026-05-27)

Public hub deploy review of `/pair`, `/pair/refresh`, `/ws/daemon`. DPoP-bound JWT chain is sound (token leak ≠ identity hijack), but the pair-code on-ramp and rate-limiting story are weaker than the rest of the design.

1. ~~**Pair code uses `Math.random()`**~~ — DONE: `generateCode` now draws from `crypto.getRandomValues` with rejection sampling for unbiased modulo on the 31-char alphabet.
2. ~~**Pair code entropy is ~30 bit**~~ — DONE: code length 6 → 8 (~40 bit). `XXXX-XXXX` format. PWA settings UI + e2e-real test regex + demo placeholder updated; daemon CLI passes the code through verbatim so no parser change needed.
3. ~~**No rate limit on `/pair` or `/ws/daemon`**~~ — DONE: in-memory sliding-window limiter keyed on resolved client IP, applied to `/pair`, `/pair/refresh`, `/ws/daemon`. Defaults 10/30/30 req/min/IP, configurable via `HUB_RATELIMIT_PAIR_PER_MIN` / `HUB_RATELIMIT_PAIR_REFRESH_PER_MIN` / `HUB_RATELIMIT_WS_DAEMON_PER_MIN`.
4. ~~**Pair code TTL not audited**~~ — DONE: `/pair/issue` route hard-codes 300_000 ms; `issueCode` itself clamps any caller-supplied ttlMs to `MAX_PAIR_TTL_MS = 5 * 60_000`. Test asserts the clamp.
5. ~~**Reverse-proxy bypass paths must be documented**~~ — DONE: `docs/operations/reverse-proxy.md` covers which paths must not be wrapped, nginx + oauth2-proxy and Caddy `forward_auth` examples, and the `HUB_TRUSTED_PROXIES` knob. Linked from `CLAUDE.md`.
6. ~~**DPoP htu standards-compliant scheme handling (Plan B)**~~ — DONE: when the request peer is in `HUB_TRUSTED_PROXIES`, hub reconstructs the public URL from `X-Forwarded-Proto` + `X-Forwarded-Host` and uses that for DPoP htu matching. Empty `HUB_TRUSTED_PROXIES` (default) preserves the scheme-collapsing fallback so behavior is unchanged unless explicitly opted in.

Out of scope here (covered by Backlog #5 "Security audit"): full threat model of WS auth + channel-permission protocol.

## AskUserQuestion remote relay (surfaced 2026-05-27, workaround shipped, tracking upstream)

`AskUserQuestion` (CC built-in clarification tool) does not surface to the PWA via the channel protocol. Workaround shipped 2026-05-27 via PreToolUse hook → daemon socket → hub → PWA → daemon → hook stdout. Tracking upstream:

- **Upstream** [anthropics/claude-code#59245](https://github.com/anthropics/claude-code/issues/59245) (Open) — RFC for `notifications/claude/channel/ask_question_request` / `ask_question_answer`. When this lands, replace the `.claude/hooks/ask-user-relay.ts` entry point with a plugin-side channel notification handler — daemon/hub/PWA frames stay (they were designed mirroring the proposed shape so the cutover is mechanical).
- **Related** [#58463](https://github.com/anthropics/claude-code/issues/58463) (Open) — JSONL flush regression (CC 2.1.139+ holds `tool_use` until answered) ruled out the JSONL-tail path. Re-confirmed locally on 2.1.150 — grep returned 0 matches while a question was pending in tmux.
- **Related** [#59908](https://github.com/anthropics/claude-code/issues/59908) — Notification hook fires for AskUserQuestion in 2.1.146+; we don't currently use it (the PreToolUse hook already grabs control of the flow), but it's available for "ring a bell" UX if a future user wants it.

### Implementation

Architecturally symmetric to permission relay; only the entry point differs (local PreToolUse hook instead of channel notification). The trade-off is binary: hook intercepts → local tmux UI is hidden, only PWA renders (documented in #59245 by hinescreative).

- **proto** — `HookAskUserQuestion{Request,Answer}` (hook ↔ daemon socket); `DaemonAskUserQuestion{Request,Resolved}` (daemon ↔ hub); `PwaAskUserQuestion{Request,Resolved}` + `PwaToHubAskUserQuestionAnswer` + `HubAskUserQuestionAnswer` (hub ↔ PWA). All wired into the four union types in `packages/proto/src/frames.ts`.
- **daemon** — `LiveSessions.getByClaudeSessionId` resolves the hook's `claude_session_id` (== CC's `session_id` from hook stdin) to the plugin-issued daemon `session_id`. Socket server accepts `ask_user_question_request` from any connected client (hook scripts use the same Unix socket as the plugin); per-request entry in `askToClient` map carries the originating socket + an expiry timer keyed on the request's `expires_at`. Answer from hub → reply written back to the same socket → hub `ask_user_question_resolved` echo.
- **hub** — router fans `ask_user_question_request` / `ask_user_question_resolved` daemon→PWA and `ask_user_question_answer` PWA→daemon, mirroring the permission relay handlers in `packages/hub/src/router.ts`.
- **PWA** — `pendingQuestions` keyed by `request_id` in `HubState`; `AskQuestionSurface` component renders the question card (reused styling idiom from `PermissionSurface`); `sendAskAnswer` action dispatches `ask_user_question_answer`. Single visible request at a time; cancel is local-only (daemon side keeps the request open until expiry).
- **hook** — `.claude/hooks/ask-user-relay.ts` is a Bun-runnable PreToolUse hook. Reads CC stdin, connects to `$CC_REMOTE_SOCKET` (or `~/.cc-remote/daemon.sock`), sends the request, blocks on the daemon's reply, then emits `{ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: <answer text> } }`. The model treats the deny reason as a synthesized tool result and proceeds. Fallback reasons cover `expired`, `session_unknown`, `no_pwa` (each instructs the model to pick a sensible default rather than re-call AskUserQuestion).
- **settings** — `.claude/settings.json` registers PreToolUse matcher `AskUserQuestion` → hook command `$CLAUDE_PROJECT_DIR/.claude/hooks/ask-user-relay.ts` with a 350s timeout (matches the daemon's 5min `expires_at` plus headroom).
- **Tests** — proto frame round-trip (5 cases); registry `getByClaudeSessionId`; daemon socket round-trip; hub router fan-out (4 cases); PWA reducer for `ask_user_question_{request,resolved}` + `outbound_ask_answer`; SSR snapshots of `AskQuestionSurface`; hook script integration tests against a fake daemon socket (round-trip, daemon-offline fallback, non-AskUserQuestion pass-through). e2e-real scenario `23-ask-user-question.test.ts` drives the full path through compose hub → fake-claude session register → spawn hook → click in PWA → assert hook stdout.

## Backlog (non-UI, no plan written yet)

These are deferred follow-ups beyond what the 16 plans + rework + real-e2e + chat-routing covered. Each would need its own plan/spec before starting.

1. **Packaging & distribution** — `cc-remote` CLI is `bun install`-only; no npm publish, homebrew tap, or single-file binary.
2. **Production hub deployment** — only local docker compose (`tools/demo-channel.sh` and `e2e-real/docker-compose.yml`) exists; no systemd unit, public TLS termination, or multi-tenant isolation story.
3. **Observability** — daemon/hub use `console` logs only; no structured logs, metrics export, or reconnect-failure indicators.
4. ~~**Real push notification chain**~~ — **PARTIAL** (Web Push end-to-end shipped via `plan-push-topics-04-deploy`; native APNs/FCM SDKs deliberately skipped, browsers bridge to them).
5. **Security audit** — IAS device pairing, WS auth, and the channel-permission protocol have not been threat-modeled end-to-end.

## AionUi 借鉴 6 项 (surfaced 2026-06-06)

调研背景见 `docs/research/aionui-comparison.md`。已确认决策：**不走 ACP**，但抄 6 条值得借鉴的工程做法。逐项串行做，按下面顺序。

**Phase 1 — 健壮性地基**

1. **WebSocket 心跳 (#6)** — IN PROGRESS. PWA 主动 ping、hub 回 pong。当前 `useHub.ts:650-728` 有指数退避 + frameless-open 鉴权检测，但 `grep ping|heartbeat|setInterval` 在 PWA 和 hub 双向均 0 命中。Spec 起草中。
2. **进程残留兜底 (#4)** — daemon 当前 `start_session` spawn 完 `r.unref()` 就走，**完全没有** PID / process group registry。崩溃后留下的 tmux session 现在靠用户手动 `tmux kill-session` 清。抄 AionUi `web-host/src/agent-process-registry.ts` 模式：`runtime/agent-process-registry.json` + 启动遍历清理。

**Phase 2 — Proto 改造（一次性）**

3. **AgentHandshake 4 块元数据 (#3)** — `slash-inventory.ts` 有 `available_commands` 雏形，`agent_capabilities / available_modes / available_models` 都没有。需要 daemon 探测 (先实验 `claude --capabilities` 是否存在，否则 sniff `~/.claude/settings.json`) + 新 frame `agent_handshake` + PWA 新 hook `useAgentCapabilities`。

**Phase 3 — UX 抛光**

4. **Thinking 折叠 + elapsed (#1)** — `renderTimelineItem.tsx:90-100` 当前 11 行裸文本渲染 Reasoning。抄 AionUi `MessageThinking.tsx` 95 行的折叠 + elapsed 计时 + done 三态。
5. **Permission/Ask 答完回执 (#5)** — `InlinePermissionCard` 已超过 AionUi（tokenized command + risk detection），但答完直接消失没回执。补 AionUi 的"绿色 ✓ banner"或 fade-out 反馈。`AskQuestionSurface` 维持 modal 形态（小屏 PWA 聚焦更好），不抄 inline。
6. **流式合并审计 (#2)** — `mergeTimeline` 已经按 `toolCallId` 覆盖（实质做了）。最后一项是审计 `TextMessageChunk` / `ReasoningMessageChunk` 是不是也按 `messageId` 累计而非 append。预期是已经做好的，零行到半天的代码量。

## Plan completed (2026-05-26)

- `docs/superpowers/specs/2026-05-25-push-topics-design.md` + plans 01–04 — push topic registry, per-daemon mute, DND, PWA manifest, e2e scenario 21. Tagged `plan-push-topics-01-foundation` … `plan-push-topics-04-deploy`. Hub: migration v3 (`topic_subscriptions` + `dnd_settings`), `push-topics.ts` registry, `topic-subscriptions` repo with 3-level resolution, `dnd.ts` + repo, `dispatchTopic` central function, router refactored to delete 4 private dispatchers, new HTTP API (`GET /push/topics`, `PUT/DELETE /push/topics/subscriptions`, `PUT /push/dnd`), legacy `/push/preferences` shim translates to topic_subscriptions, sw.js renders server-built body/tag. PWA: `usePushTopics` hook (replaces `usePushPrefs`), data-driven `SettingsDrawer` Notifications section (DND + Defaults + Per-daemon overrides), `manifest.webmanifest` + maskable icons + apple-touch-icon. Ops: `docs/operations/push-deployment.md`. Tests: 430 unit (was 293; +137 new) + e2e scenario 21 green.

## Plan completed (2026-05-23)

- `docs/superpowers/plans/2026-05-23-settings-page-plan.md` — settings page (daemons list, pair code, tri-state errors). **DONE** — tagged `plan-settings-page`. Hub: `daemons.display_name` migration v2 + `listDaemonsByOwner/renameDaemon/revokeDaemonAuthorized` repo helpers + `Router.getConnectedDaemonIds/closeDaemonConnection` + `GET/PATCH/DELETE /daemons` + `POST /pair/issue`. PWA: `Resource<T>` tri-state + `useDaemons/usePairing/usePushPrefs` (replaces `useDevices`) + `SettingsDrawer` rewrite + RealApp/DemoApp wiring. Tests: 293 unit (was 169) + 19 e2e green incl. new `20-pair-from-pwa`. Side-effect: fixed `loginAndConnect` OIDC chain (allowed 302/303, relative Location, multi-hop consent path) so scenario 15 passes again.

## Plan completed (2026-05-20)

- `docs/superpowers/plans/2026-05-20-chat-routing-plan.md` — chat routing PWA↔Claude. **DONE** — tagged `plan-chat-routing`. PWA chat composer + log; hub broadcasts chat both directions; daemon routes chat_send/chat_out between hub and plugin. 169 unit tests pass (was 154; +15 new). 13 e2e-real scenarios green incl. new `12-chat-roundtrip.test.ts`.

- `docs/superpowers/plans/2026-05-20-real-e2e-plan.md` — real-component e2e suite. **DONE** — tagged `plan-real-e2e`. 11 acceptance scenarios in `e2e-real/tests/`. Full suite `bun test e2e-real/` runs in ~5.4 min wall time (under spec §8 < 6 min budget), 12 pass / 0 fail. Daemon idle-timer was fixed (`8b96dcc`) and inter-scenario compose lifecycle hardened (`b985c56`, `8cfa556`).

- `docs/superpowers/plans/2026-05-19-plugin-mcp-rework-plan.md` — plugin MCP rework. **DONE** — tagged `plan-plugin-mcp-rework`.

## Superseded plans

- `docs/superpowers/plans/2026-05-19-plugin-mcp-plan.md` — original PMCP plan; superseded by the rework plan above.
- `docs/superpowers/plans/2026-05-19-real-e2e-plan.SUPERSEDED.md` — pre-rewrite real-e2e plan.

## Older prior context

- `docs/superpowers/specs/2026-05-18-open-cc-remote-design.md` — original v1 design spec
- `docs/superpowers/plans/2026-05-18-open-cc-remote-plan-01-foundation.md` through `plan-16-status.md` — the 16 implementation plans that built v1
- All v1 work is tagged `plan-01-foundation` … `plan-16-status` (16 git tags)
- Memory entries (cross-session): `~/.claude/projects/-Users-i060912-SAPDevelop-channel/memory/`

## Snapshot at 2026-05-20

- 154 tests pass in `bun test packages/` (was 164 before plugin MCP rework consolidated some tests)
- 6 packages typecheck clean (proto, hub, daemon, plugin, pwa, e2e-real)
- 11 e2e-real scenarios committed; full suite `bun test e2e-real/` GREEN in ~5.4 min

