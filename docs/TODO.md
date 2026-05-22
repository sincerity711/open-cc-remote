# TODO

Pending work — consolidated record. Update entries inline as items move from pending → done.

## Demo / start_session next steps (surfaced 2026-05-22)

Hit while trying to spawn a new session (`~/SAPDevelop/obsidian-kg`) from the PWA in the demo. Worked around at the demo level; underlying issues remain.

1. **`cc-remote pair` clobbers config.json** — `packages/daemon/bin/cc-remote.ts:56` rewrites the file down to `{daemon_id, hub_url}` only, dropping `allow_start`, `allowed_cwd_prefix`, `spawn_command`, `idle_window_ms`. Demo script worked around by re-emitting after pair, but the CLI should preserve / merge.
2. **`spawn_command` default is dead** — `packages/daemon/src/config.ts:46` defaults to `claude --channels plugin:cc-remote@local`, which is the pre-2.1 CLI interface. Anyone using the daemon without overriding gets a silent no-op. Either remove the default (require explicit) or update to the working `--mcp-config + --dangerously-load-development-channels` form.
3. **PWA new-session has no error feedback** — daemon rejects (`allow_start=false`, cwd outside prefix, tmux spawn error) only emit to `daemon.log`; PWA shows nothing. Add an error frame back to PWA + a toast on rejection.
4. **start_session won't create missing cwd** — `tmux new-session -c <missing-dir>` fails silently. Either daemon `mkdir -p` the cwd before spawn (gated by `allowed_cwd_prefix`) or surface the error per #3.
5. **`mcp-config.json` is co-located with demo state** — `spawn_command` references `/tmp/cc-remote-demo/mcp-config.json`. For non-demo use the daemon should ship its own MCP config (or generate one in its state dir) rather than depend on a sibling tool's path.
6. **Init CLI for daemon config** — user wants a `cc-remote init` (or similar) that writes a sane config.json with `allow_start`, `allowed_cwd_prefix=$HOME`, working `spawn_command`. Avoids the hand-edit dance the demo currently does. (Captures the user's "config 以后做初始化的 cli" remark.)

## Backlog (non-UI, no plan written yet)

These are deferred follow-ups beyond what the 16 plans + rework + real-e2e + chat-routing covered. Each would need its own plan/spec before starting.

1. **Packaging & distribution** — `cc-remote` CLI is `bun install`-only; no npm publish, homebrew tap, or single-file binary.
2. **Production hub deployment** — only local docker compose (`tools/demo-channel.sh` and `e2e-real/docker-compose.yml`) exists; no systemd unit, public TLS termination, or multi-tenant isolation story.
3. **Observability** — daemon/hub use `console` logs only; no structured logs, metrics export, or reconnect-failure indicators.
4. **Real push notification chain** — `plan-11-offline-push` validated against fake VAPID; APNs / FCM not wired.
5. **Security audit** — IAS device pairing, WS auth, and the channel-permission protocol have not been threat-modeled end-to-end.

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

