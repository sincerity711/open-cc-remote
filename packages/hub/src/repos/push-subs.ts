import type { Db } from "../db.ts";

export interface PushPreferences {
  permission?: boolean;
  offline?: boolean;
}

export interface PushSubRow {
  device_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  preferences: PushPreferences;
}

const DEFAULT_PREFS: PushPreferences = { permission: true };

export function addPushSub(
  db: Db,
  device_id: string,
  endpoint: string,
  p256dh: string,
  auth: string,
): void {
  const preferences = JSON.stringify(DEFAULT_PREFS);
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
  const rows = db.query(
    `SELECT ps.device_id, ps.endpoint, ps.p256dh, ps.auth, ps.preferences
     FROM push_subs ps
     JOIN devices d ON d.device_id = ps.device_id
     WHERE d.owner_sub = ? AND d.revoked_at IS NULL`,
  ).all(owner_sub) as Array<{
    device_id: string; endpoint: string; p256dh: string; auth: string; preferences: string;
  }>;
  return rows.map((r) => ({
    device_id: r.device_id,
    endpoint: r.endpoint,
    p256dh: r.p256dh,
    auth: r.auth,
    preferences: parsePrefs(r.preferences),
  }));
}

export function getPreferences(db: Db, device_id: string): PushPreferences {
  const row = db.query("SELECT preferences FROM push_subs WHERE device_id = ?").get(device_id) as { preferences: string } | null;
  if (!row) return { ...DEFAULT_PREFS };
  return parsePrefs(row.preferences);
}

export function setPreferences(db: Db, device_id: string, prefs: PushPreferences): void {
  const existing = getPreferences(db, device_id);
  const merged: PushPreferences = { ...existing, ...prefs };
  db.prepare("UPDATE push_subs SET preferences = ? WHERE device_id = ?").run(JSON.stringify(merged), device_id);
}

function parsePrefs(raw: string): PushPreferences {
  try {
    const parsed = JSON.parse(raw) as PushPreferences;
    return { ...DEFAULT_PREFS, ...parsed };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}
