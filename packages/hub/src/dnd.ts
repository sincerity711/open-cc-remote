// packages/hub/src/dnd.ts
export interface DndSettings {
  enabled: boolean;
  start_hh_mm: string | null;
  end_hh_mm: string | null;
  timezone: string | null;
}

function parseHhMm(s: string): number {
  const [h, m] = s.split(":").map((x) => Number(x));
  return h! * 60 + m!;
}

export function isInDndWindow(dnd: DndSettings | null, nowMs: number): boolean {
  if (!dnd?.enabled) return false;
  if (!dnd.start_hh_mm || !dnd.end_hh_mm || !dnd.timezone) return false;

  let parts: Record<string, string>;
  try {
    const fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: dnd.timezone, hour: "2-digit", minute: "2-digit", hour12: false,
    });
    parts = Object.fromEntries(
      fmt.formatToParts(new Date(nowMs)).map((p) => [p.type, p.value]),
    );
  } catch {
    return false;
  }
  const cur = Number(parts.hour) * 60 + Number(parts.minute);
  const start = parseHhMm(dnd.start_hh_mm);
  const end = parseHhMm(dnd.end_hh_mm);
  if (start === end) return false;
  return start < end ? (cur >= start && cur < end) : (cur >= start || cur < end);
}
