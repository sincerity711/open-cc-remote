# TODO

Pending work — consolidated record. Update entries inline as items move from pending → done.

## Plan in flight (2026-05-19)

`docs/superpowers/plans/2026-05-19-plugin-mcp-rework-plan.md` — the plugin MCP rework. Supersedes the paused PMCP plan after empirical findings showed Claude Code 2.1.143 requires `.claude-plugin/plugin.json` + `.mcp.json`, not just a `bin` field. Spec at `docs/superpowers/specs/2026-05-19-plugin-mcp-rework-design.md`.

Once this rework lands, the real-e2e plan (`docs/superpowers/plans/2026-05-19-real-e2e-plan.md`, T1–T19) is unblocked and can resume.

## Superseded plans

- `docs/superpowers/plans/2026-05-19-plugin-mcp-plan.md` — original PMCP plan; superseded by the rework plan above.

## Resume order (when continuing)

1. Execute the plugin MCP plan (PMCP-T1 → T7). Validates against the real `claude` binary.
2. Execute the real-e2e plan (T1 → T19), threading the modernized plugin through tasks 13–18 ("real Claude" scenarios). Tasks 02/03/10 still use Path B (`CC_REMOTE_FAKE_PERMISSION` env) per `docs/superpowers/research/channel-permission-protocol.md`.
3. Dispatch the post-dev tester / fixer / review-lead team to harden the suite.

## Older prior context

- `docs/superpowers/specs/2026-05-18-open-cc-remote-design.md` — original v1 design spec
- `docs/superpowers/plans/2026-05-18-open-cc-remote-plan-01-foundation.md` through `plan-16-status.md` — the 16 implementation plans that built v1
- All v1 work is tagged `plan-01-foundation` … `plan-16-status` (16 git tags)
- Memory entries (cross-session): `~/.claude/projects/-Users-i060912-SAPDevelop-channel/memory/`
  - `project_naming.md`, `auth_design.md`, `project_progress_20260518.md`, `real_e2e_prerequisite.md`

## Snapshot at pause (2026-05-19)

- 164 tests pass; 5 packages typecheck clean
- ~145 commits in main
- Repo at HEAD: `f52ec2e Add plugin MCP modernization plan (prerequisite for real-e2e)`
