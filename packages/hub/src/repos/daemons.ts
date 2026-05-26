import type { Db } from "../db.ts";

export interface DaemonRow {
  daemon_id: string;
  owner_sub: string;
  hostname: string | null;
  display_name: string | null;
  public_key_jwk: string;
  jwt_jti: string | null;
  jwt_exp: number | null;
  revoked_at: number | null;
}

export function pairDaemon(
  db: Db,
  daemon_id: string,
  owner_sub: string,
  public_key_jwk: string,
  hostname: string | null,
  paired_at?: number,
): void {
  db.prepare(
    "INSERT INTO daemons (daemon_id, owner_sub, hostname, public_key_jwk, paired_at) VALUES (?, ?, ?, ?, ?)",
  ).run(daemon_id, owner_sub, hostname, public_key_jwk, paired_at ?? Date.now());
}

export function findDaemon(db: Db, daemon_id: string): DaemonRow | null {
  return (db.query(
    "SELECT daemon_id, owner_sub, hostname, display_name, public_key_jwk, jwt_jti, jwt_exp, revoked_at FROM daemons WHERE daemon_id = ?",
  ).get(daemon_id) as DaemonRow | null);
}

export function setJwtId(db: Db, daemon_id: string, jti: string, exp: number): void {
  db.prepare("UPDATE daemons SET jwt_jti = ?, jwt_exp = ? WHERE daemon_id = ?").run(jti, exp, daemon_id);
}

export function revokeDaemon(db: Db, daemon_id: string): void {
  db.prepare("UPDATE daemons SET revoked_at = ? WHERE daemon_id = ?").run(Date.now(), daemon_id);
}

export function touchDaemon(db: Db, daemon_id: string): void {
  db.prepare("UPDATE daemons SET last_seen_at = ? WHERE daemon_id = ?").run(Date.now(), daemon_id);
}

export interface DaemonListItem {
  daemon_id: string;
  display_name: string | null;
  hostname: string | null;
  paired_at: number;
  last_seen_at: number | null;
}

export function listDaemonsByOwner(db: Db, owner_sub: string): DaemonListItem[] {
  return db.query(
    `SELECT daemon_id, display_name, hostname, paired_at, last_seen_at
     FROM daemons
     WHERE owner_sub = ? AND revoked_at IS NULL
     ORDER BY paired_at DESC`,
  ).all(owner_sub) as DaemonListItem[];
}

export function renameDaemon(
  db: Db, owner_sub: string, daemon_id: string, display_name: string,
): boolean {
  const result = db.prepare(
    "UPDATE daemons SET display_name = ? WHERE daemon_id = ? AND owner_sub = ? AND revoked_at IS NULL",
  ).run(display_name, daemon_id, owner_sub);
  return result.changes === 1;
}

export function revokeDaemonAuthorized(
  db: Db, owner_sub: string, daemon_id: string,
): boolean {
  const result = db.prepare(
    "UPDATE daemons SET revoked_at = ?, jwt_jti = NULL WHERE daemon_id = ? AND owner_sub = ? AND revoked_at IS NULL",
  ).run(Date.now(), daemon_id, owner_sub);
  return result.changes === 1;
}
