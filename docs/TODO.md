# TODO

Pending work — consolidated record. Update entries inline as items move from pending → done.

## Active goal (paused 2026-05-19)

The original directive was: write the real-e2e plan, develop with an agent team, then deploy a post-dev team (tester / fixer / review-lead). Status:

- ✅ Plan written and committed: `docs/superpowers/plans/2026-05-19-real-e2e-plan.md` (commit `c34b503`)
- ✅ Task 0 of that plan complete: protocol research at `docs/superpowers/research/channel-permission-protocol.md` (commits `6ad49d9`, `bfda5b7`)
- ⛔ Tasks 1–19 of real-e2e: **blocked**
- ⛔ Post-dev tester / fixer / review-lead team: **not dispatched**

### Why blocked

Research confirmed that:
1. Claude Code 2.1.143 removed the `--channels` flag (replaced by `--plugin-dir` and `claude plugin install`)
2. Our `packages/plugin/` is not a real MCP stdio server — it can't be loaded by current Claude Code as a plugin
3. The fake-claude harness in `tools/fake-claude/` masked this gap end-to-end across all 164 in-process tests

Real e2e needs a working plugin first.

## Prerequisite plan (also paused 2026-05-19)

`docs/superpowers/plans/2026-05-19-plugin-mcp-plan.md` (commit `f52ec2e`) — 7 tasks:

- ⛔ PMCP-T1: add `@modelcontextprotocol/sdk` dep + verify `bin`
- ⛔ PMCP-T2: dual-transport plugin scaffold (MCP stdio + Unix socket)
- ⛔ PMCP-T3: handle inbound `notifications/claude/channel/permission_request`
- ⛔ PMCP-T4: emit outbound `notifications/claude/channel/permission` on daemon reply
- ⛔ PMCP-T5: smoke test against real `claude --plugin-dir` invocation
- ⛔ PMCP-T6: verify 164 existing tests still pass with dual-mode
- ⛔ PMCP-T7: README + tag `plan-plugin-mcp`

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
