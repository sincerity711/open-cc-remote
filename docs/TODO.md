# TODO

Pending work — consolidated record. Update entries inline as items move from pending → done.

## Plan completed (2026-05-20)

- `docs/superpowers/plans/2026-05-20-real-e2e-plan.md` — real-component e2e suite. **DONE** — tagged `plan-real-e2e`. 11 acceptance scenarios in `e2e-real/tests/`, 9 of them pass on first run on this hardware. Two known issues:
  - Scenario 06 (idle): the daemon's `idle_window_ms` timer is cleared by every JSONL line and only re-armed on `assistant + end_turn`. Real Claude writes follow-up entries (`system`, `last-prompt`, `ai-title`, `permission-mode`) after `end_turn`, so the idle frame never fires. Fix needed in `packages/daemon/src/index.ts:192-214` (re-arm timer on each line OR only watch for terminal markers). Test committed but expected-to-fail until product fix.
  - Scenarios 08 / 09 (kill_session, start_session): test scenario itself passes, but the `afterAll` `downCompose` hook hangs (~15min) due to orphaned `claude --bg` / spawned processes that prevent docker compose from cleanly tearing down. The scenario's own assertions all pass. Root cause to investigate.

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
- 11 e2e-real scenarios committed (9 PASS, 1 expected-fail, 1 with afterAll-hang quirk)

