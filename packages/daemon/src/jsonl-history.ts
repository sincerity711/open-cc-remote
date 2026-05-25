import { existsSync, readFileSync } from "node:fs";
import type { AGUIEvent } from "@cc-remote/proto";
import { ClaudeCodeAdapter } from "./adapters/claude-code";

const adapter = new ClaudeCodeAdapter();

export interface HistoryEvent {
  jsonl_offset: number;
  payload: AGUIEvent[];
}

export async function readHistory(
  path: string,
  before_offset: number,
  limit: number,
  sessionId: string,
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
    let row: unknown;
    try { row = JSON.parse(line); } catch { row = { raw: line }; }
    const payload = adapter.convertRow(row, {
      sessionId,
      jsonlOffset: lineEndOffset,
    });
    all.push({ jsonl_offset: lineEndOffset, payload });
    pos = nl + 1;
  }

  // Last `limit` items, in chronological order.
  return all.slice(-limit);
}
