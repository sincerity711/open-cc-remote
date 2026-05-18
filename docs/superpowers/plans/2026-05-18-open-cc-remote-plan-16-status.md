# open-cc-remote — Plan 16: cc-remote status CLI

> **For agentic workers:** Compressed.

**Goal:** `cc-remote status` shows everything an operator needs at a glance: daemon process state, pair binding, JWT freshness, recent permission audit entries.

**Architecture:**
- New CLI subcommand `status`
- Reads config.json + state.json + state_dir/db.sqlite
- Prints structured human-readable output

---

## Tasks

### T1 — `cc-remote status` subcommand

Read all locally-known state:
- config.json: daemon_id, hub_url, allow_kill, allow_start
- state.json: jwt_exp (if paired)
- state_dir/db.sqlite: count of permissions and the 5 most recent (request_id, tool, decision, decided_via, age)
- ~/.cc-remote/daemon.log: last few lines if present (best-effort, don't crash if missing)

Prints sections.

### T2 — Tests + README + tag

`packages/daemon/tests/cli-status.test.ts` — subprocess test asserting status prints expected sections from a synthetic state dir. README + tag plan-16-status.
