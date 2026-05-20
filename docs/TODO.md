# TODO

Pending work — consolidated record. Update entries inline as items move from pending → done.

## Plan completed (2026-05-20)

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

