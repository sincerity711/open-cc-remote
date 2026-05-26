// packages/hub/src/repos/dnd.ts
import type { Db } from "../db.ts";
import type { DndSettings } from "../dnd.ts";
export type { DndSettings };

export function getDndSettings(db: Db, device_id: string): DndSettings | null {
  const row = db.query(
    "SELECT enabled, start_hh_mm, end_hh_mm, timezone FROM dnd_settings WHERE device_id = ?",
  ).get(device_id) as { enabled: number; start_hh_mm: string | null; end_hh_mm: string | null; timezone: string | null } | null;
  if (!row) return null;
  return {
    enabled: row.enabled === 1,
    start_hh_mm: row.start_hh_mm,
    end_hh_mm: row.end_hh_mm,
    timezone: row.timezone,
  };
}

export function setDndSettings(db: Db, device_id: string, settings: DndSettings): void {
  db.prepare(
    `INSERT INTO dnd_settings (device_id, enabled, start_hh_mm, end_hh_mm, timezone)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(device_id) DO UPDATE SET
       enabled = excluded.enabled,
       start_hh_mm = excluded.start_hh_mm,
       end_hh_mm = excluded.end_hh_mm,
       timezone = excluded.timezone`,
  ).run(
    device_id,
    settings.enabled ? 1 : 0,
    settings.start_hh_mm,
    settings.end_hh_mm,
    settings.timezone,
  );
}
