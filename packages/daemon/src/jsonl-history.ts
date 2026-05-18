import { existsSync, readFileSync } from "node:fs";

export interface HistoryEvent {
  jsonl_offset: number;
  payload: unknown;
}

export async function readHistory(
  path: string,
  before_offset: number,
  limit: number,
): Promise<HistoryEvent[]> {
  if (!existsSync(path)) return [];
  if (before_offset <= 0 || limit <= 0) return [];

  const content = readFileSync(path, "utf8");
  let pos = 0;
  const all: HistoryEvent[] = [];

  while (pos < content.length) {
    const nl = content.indexOf("\n", pos);
    if (nl === -1) break;
    const line = content.slice(pos, nl);
    // Use byte length, not char length, for offsets (matches watcher).
    const lineEndOffset = Buffer.byteLength(content.slice(0, nl + 1), "utf8");
    if (lineEndOffset > before_offset) break;
    let payload: unknown;
    try { payload = JSON.parse(line); } catch { payload = { raw: line }; }
    all.push({ jsonl_offset: lineEndOffset, payload });
    pos = nl + 1;
  }

  // Last `limit` items, in chronological order.
  return all.slice(-limit);
}
