import type { Db } from "../db.ts";

export interface PushSubRow {
  device_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export function addPushSub(
  db: Db,
  device_id: string,
  endpoint: string,
  p256dh: string,
  auth: string,
): void {
  // Default preferences: only permission events trigger push (Plan 5 scope).
  const preferences = JSON.stringify({ permission: true });
  db.prepare(
    `INSERT INTO push_subs (device_id, endpoint, p256dh, auth, preferences)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(device_id) DO UPDATE SET endpoint=excluded.endpoint, p256dh=excluded.p256dh, auth=excluded.auth`,
  ).run(device_id, endpoint, p256dh, auth, preferences);
}

export function removePushSub(db: Db, device_id: string): void {
  db.prepare("DELETE FROM push_subs WHERE device_id = ?").run(device_id);
}

export function findSubsByOwner(db: Db, owner_sub: string): PushSubRow[] {
  return db.query(
    `SELECT ps.device_id, ps.endpoint, ps.p256dh, ps.auth
     FROM push_subs ps
     JOIN devices d ON d.device_id = ps.device_id
     WHERE d.owner_sub = ? AND d.revoked_at IS NULL`,
  ).all(owner_sub) as PushSubRow[];
}
