import { createHash, randomBytes } from "node:crypto";
import type { Db } from "../db.ts";

export interface DeviceRow {
  device_id: string;
  owner_sub: string;
  display_name: string | null;
  expires_at: number;
  revoked_at: number | null;
}

export interface CreatedDevice {
  device_id: string;
  bearer: string;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createDevice(
  db: Db,
  owner_sub: string,
  display_name: string,
  user_agent: string | null,
  ttlMs: number,
): CreatedDevice {
  const device_id = `dev-${randomBytes(8).toString("hex")}`;
  const bearer = `ccr_${randomBytes(32).toString("base64url")}`;
  const now = Date.now();
  db.prepare(
    "INSERT INTO devices (device_id, owner_sub, display_name, user_agent, paired_at, last_seen_at, token_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(device_id, owner_sub, display_name, user_agent, now, now, hashToken(bearer), now + ttlMs);
  return { device_id, bearer };
}

export function findDeviceByToken(db: Db, bearer: string): DeviceRow | null {
  return (db.query(
    "SELECT device_id, owner_sub, display_name, expires_at, revoked_at FROM devices WHERE token_hash = ?",
  ).get(hashToken(bearer)) as DeviceRow | null);
}

export function revokeDevice(db: Db, device_id: string): void {
  db.prepare("UPDATE devices SET revoked_at = ? WHERE device_id = ?").run(Date.now(), device_id);
}

export function touchDevice(db: Db, device_id: string): void {
  db.prepare("UPDATE devices SET last_seen_at = ? WHERE device_id = ?").run(Date.now(), device_id);
}

export interface DeviceListItem {
  device_id: string;
  display_name: string | null;
  paired_at: number;
  last_seen_at: number | null;
}

export function listDevicesByOwner(db: Db, owner_sub: string): DeviceListItem[] {
  return db.query(
    "SELECT device_id, display_name, paired_at, last_seen_at FROM devices WHERE owner_sub = ? AND revoked_at IS NULL ORDER BY paired_at DESC",
  ).all(owner_sub) as DeviceListItem[];
}

export function renameDevice(db: Db, owner_sub: string, device_id: string, display_name: string): boolean {
  const result = db.prepare(
    "UPDATE devices SET display_name = ? WHERE device_id = ? AND owner_sub = ? AND revoked_at IS NULL",
  ).run(display_name, device_id, owner_sub);
  return result.changes === 1;
}

export function revokeDeviceAuthorized(db: Db, owner_sub: string, device_id: string): boolean {
  const result = db.prepare(
    "UPDATE devices SET revoked_at = ? WHERE device_id = ? AND owner_sub = ? AND revoked_at IS NULL",
  ).run(Date.now(), device_id, owner_sub);
  return result.changes === 1;
}
