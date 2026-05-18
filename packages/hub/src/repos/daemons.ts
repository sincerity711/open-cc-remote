import type { Db } from "../db.ts";

export interface DaemonRow {
  daemon_id: string;
  owner_sub: string;
  hostname: string | null;
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
): void {
  db.prepare(
    "INSERT INTO daemons (daemon_id, owner_sub, hostname, public_key_jwk, paired_at) VALUES (?, ?, ?, ?, ?)",
  ).run(daemon_id, owner_sub, hostname, public_key_jwk, Date.now());
}

export function findDaemon(db: Db, daemon_id: string): DaemonRow | null {
  return (db.query(
    "SELECT daemon_id, owner_sub, hostname, public_key_jwk, jwt_jti, jwt_exp, revoked_at FROM daemons WHERE daemon_id = ?",
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
