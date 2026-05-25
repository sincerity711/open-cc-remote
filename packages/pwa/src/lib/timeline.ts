import type {
  PwaChatBroadcast,
  PwaPermissionRequest,
  PwaPermissionResolved,
} from "@cc-remote/proto";
import type { BufferedEvent } from "../hooks/useHub";
import type { RenderItem } from "../screens/timeline/types";

export interface MergeTimelineArgs {
  events: BufferedEvent[];
  chat: PwaChatBroadcast[];
  pending: PwaPermissionRequest[];
  resolved: PwaPermissionResolved[];
}

interface TimedItem {
  tsMs: number;
  rank: number;
  item: RenderItem;
}

/**
 * RAW events whose underlying JSONL type carries no user-facing meaning.
 * The adapter has already converted these to RAW; the renderer drops them.
 */
const HIDDEN_PAYLOAD_TYPES = new Set<string>([
  "attachment",
  "summary",
  "queue-operation",
  "mcp_instructions_data",
  "ai-title",
  "last-prompt",
  "permission-mode",
  "pr-link",
]);

export function mergeTimeline(args: MergeTimelineArgs): RenderItem[] {
  const buf: TimedItem[] = [];

  for (const be of args.events) {
    if (be.event.type === "RAW") {
      const rawType = (be.event as { event?: { type?: string } }).event?.type;
      if (rawType && HIDDEN_PAYLOAD_TYPES.has(rawType)) continue;
    }
    buf.push({
      tsMs: be.ts,
      rank: 0,
      item: {
        tag: "agui",
        id: `evt:${be.daemon_id}:${be.session_id}:${be.jsonl_offset}:${be.event_index}`,
        ts: be.ts,
        event: be.event,
      },
    });
  }

  for (const c of args.chat) {
    buf.push({
      tsMs: c.ts,
      rank: 1,
      item: {
        tag: "chat",
        id: `chat:${c.message_id}`,
        ts: c.ts,
        chat: c,
      },
    });
  }

  for (const p of args.pending) {
    const ts = (p as { ts?: number }).ts ?? Date.now();
    buf.push({
      tsMs: ts,
      rank: 2,
      item: {
        tag: "permission-inline",
        id: `perm:${p.request_id}`,
        ts,
        pending: p,
      },
    });
  }

  for (const r of args.resolved) {
    const ts = (r as { ts?: number }).ts ?? Date.now();
    buf.push({
      tsMs: ts,
      rank: 3,
      item: {
        tag: "permission-resolved",
        id: `perm-resolved:${r.request_id}`,
        ts,
        resolved: r,
      },
    });
  }

  buf.sort((a, b) => a.tsMs - b.tsMs || a.rank - b.rank);
  return buf.map((t) => t.item);
}
