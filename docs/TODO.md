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

## Backlog (non-UI, no plan written yet)

These are deferred follow-ups beyond what the 16 plans + rework + real-e2e + chat-routing covered. Each would need its own plan/spec before starting.

1. **Packaging & distribution** — `cc-remote` CLI is `bun install`-only; no npm publish, homebrew tap, or single-file binary.
2. **Production hub deployment** — only local docker compose (`tools/demo-channel.sh` and `e2e-real/docker-compose.yml`) exists; no systemd unit, public TLS termination, or multi-tenant isolation story.
3. **Observability** — daemon/hub use `console` logs only; no structured logs, metrics export, or reconnect-failure indicators.
4. ~~**Real push notification chain**~~ — **PARTIAL** (Web Push end-to-end shipped via `plan-push-topics-04-deploy`; native APNs/FCM SDKs deliberately skipped, browsers bridge to them).
5. **Security audit** — IAS device pairing, WS auth, and the channel-permission protocol have not been threat-modeled end-to-end.

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

