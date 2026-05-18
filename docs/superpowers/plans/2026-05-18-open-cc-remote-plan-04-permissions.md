# open-cc-remote — Plan 4: Permission relay

> **For agentic workers:** Compressed format — task list with key interfaces; full code in dispatch prompts.

**Goal:** When Claude Code asks the user to approve a tool call (Bash, Edit, etc.), the prompt flows daemon → hub → PWA. Tapping ✅ or ❌ flows back to Claude Code. Single-resolution lock prevents double answers.

**Architecture:**
- Plugin captures permission_request from Claude Code (via channel-permissions protocol; for now, fake-claude generates these for testing)
- Daemon persists to SQLite `permissions` table (Plan 4 introduces daemon SQLite)
- Hub routes between daemon and PWAs
- PWA shows banner with approve/deny buttons
- Single-resolution: hub takes the first reply, broadcasts `permission_resolved`, ignores subsequent replies for same `request_id`

**Out of scope:** real Claude Code permission protocol integration (deferred until we ship a real plugin); Web Push for permissions (Plan 5).

---

## Frame additions (proto)

```ts
// plugin → daemon
{ type: "permission_request", request_id: string, tool: string, args_summary: string, expires_at: number }

// daemon → plugin
{ type: "permission_reply", request_id: string, decision: "allow" | "deny" }

// daemon → hub
{ type: "permission_request", session_id: string, request_id: string, tool, args_summary, expires_at }
{ type: "permission_resolved", session_id: string, request_id: string, decision: "allow" | "deny" | "expired" | "terminal", decided_via: string }

// hub → daemon
{ type: "permission_reply", session_id: string, request_id: string, decision: "allow" | "deny" }

// hub → PWA (forward of daemon→hub frames, with daemon_id added)
// PWA → hub
{ type: "permission_reply", daemon_id: string, session_id: string, request_id: string, decision: "allow" | "deny" }
```

---

## Tasks

### T1 — Proto: permission frames

Extend the relevant unions in `frames.ts`. No new tests; codec already handles arbitrary JSON. Add no-op switch cases (`return`/`return prev`) in router.ts and ws.ts to satisfy exhaustiveness.

### T2 — Daemon SQLite + permissions repo

`packages/daemon/src/db.ts` (new) opens `${state_dir}/db.sqlite` with `permissions` table:
```sql
CREATE TABLE IF NOT EXISTS permissions (
  request_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  args_summary TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  decision TEXT,
  decided_via TEXT
);
```

Repo: `recordRequest`, `resolveRequest` (returns false if already resolved), `getRequest`. Tests for the single-resolution semantics.

### T3 — Daemon: permission flow

Modify `packages/daemon/src/index.ts`:
- Open db on startup
- On plugin `permission_request`: insert row, forward to hub (`permission_request` frame with session_id)
- Track which plugin client owns each in-flight request (to route the eventual reply back)
- On hub `permission_reply` (added to onFrame handler): call `resolveRequest`; if first to resolve, send `permission_reply` to the originating plugin client + send `permission_resolved` to hub
- Plugin's existing socket-server frame handler extended for the new frame types

### T4 — Hub: permission frames in router

Modify `packages/hub/src/router.ts`:
- New cases in `onDaemonFrame` for `permission_request` and `permission_resolved` — broadcast to PWAs (with daemon_id)
- New `onPwaCommand` method (the routes.ts handler will call this) for `permission_reply` — look up daemon_id and forward to daemon via daemonReg.send

Modify `packages/hub/src/routes.ts`'s WS message handler to dispatch `permission_reply` from PWA to `router.onPwaCommand`.

### T5 — PWA: permission banner

`packages/pwa/src/PermissionBanner.tsx` shows pending permission requests across all daemons with approve/deny buttons. Sits at the top of the page when there's a pending request, hides when none. Modify `ws.ts` to track `pendingPermissions: Record<request_id, ...>` and remove on `permission_resolved`.

### T6 — fake-claude permission trigger + e2e

Extend `tools/fake-claude/fake-claude.ts` with `--permission <tool>` that sends a permission_request after register. The plugin needs a code path to relay this — for v1 we'll just have fake-claude write the request directly via the daemon socket using a small helper, OR have plugin handle a special env var.

Simpler: plugin reads `CC_REMOTE_FAKE_PERMISSION` env on startup. If set, after register it sends a `permission_request` frame.

`e2e/permission.test.ts`: spawn full stack with `--permission Bash`; PWA-style WSS receives permission_request; PWA-style client sends permission_reply; verify daemon received reply and audit row exists.

### T7 — README + tag

Add Plan 4 status, commit, tag `plan-04-permissions`.
