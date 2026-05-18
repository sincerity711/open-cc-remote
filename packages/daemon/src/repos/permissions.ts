import type { Db } from "../db.ts";

export interface PermissionRow {
  request_id: string;
  session_id: string;
  tool: string;
  args_summary: string;
  created_at: number;
  resolved_at: number | null;
  decision: string | null;
  decided_via: string | null;
}

export function recordRequest(
  db: Db,
  request_id: string,
  session_id: string,
  tool: string,
  args_summary: string,
): void {
  db.prepare(
    "INSERT OR IGNORE INTO permissions (request_id, session_id, tool, args_summary, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(request_id, session_id, tool, args_summary, Date.now());
}

export function resolveRequest(
  db: Db,
  request_id: string,
  decision: "allow" | "deny" | "expired" | "terminal",
  decided_via: string,
): boolean {
  const result = db.prepare(
    "UPDATE permissions SET resolved_at = ?, decision = ?, decided_via = ? WHERE request_id = ? AND resolved_at IS NULL",
  ).run(Date.now(), decision, decided_via, request_id);
  return result.changes === 1;
}

export function getRequest(db: Db, request_id: string): PermissionRow | null {
  return db.query("SELECT * FROM permissions WHERE request_id = ?").get(request_id) as PermissionRow | null;
}
