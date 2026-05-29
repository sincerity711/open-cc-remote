import type { PwaPermissionResolved } from "@cc-remote/proto";
import {
  EventType,
  type ToolCallChunkEvent,
  type ToolCallResultEvent,
} from "@cc-remote/proto";
import type { BufferedEvent } from "../hooks/useHub";
import type { RenderItem } from "../screens/timeline/types";

export interface MergeTimelineArgs {
  events: BufferedEvent[];
  resolved: PwaPermissionResolved[];
}

interface TimedItem {
  tsMs: number;
  rank: number;
  // Secondary sort key for ts=0 items (FSM RUN_* markers & history events
  // whose JSONL row had no `timestamp`). Without this, ts=0 events crush
  // to epoch-zero and float to the very top of the timeline. Using
  // jsonl_offset as the tiebreaker keeps them in JSONL order, sticky
  // to whatever comes near them in the buffer.
  offset: number;
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
  "mode",
  "pr-link",
]);

export function mergeTimeline(args: MergeTimelineArgs): RenderItem[] {
  const buf: TimedItem[] = [];

  // First pass: index TOOL_CALL_RESULT events by toolCallId so we can attach
  // them to their matching TOOL_CALL_CHUNK below. Each toolCallId is expected
  // to have at most one result; if multiple show up, last one wins.
  const resultsByToolId = new Map<string, ToolCallResultEvent>();
  for (const be of args.events) {
    if (be.event.type === EventType.TOOL_CALL_RESULT) {
      const ev = be.event as ToolCallResultEvent;
      if (ev.toolCallId) resultsByToolId.set(ev.toolCallId, ev);
    }
  }

  // Track which toolCallIds we've already emitted a "tool" RenderItem for —
  // streaming chunks for the same toolCallId collapse onto the first chunk
  // (chunk wins for ts/id stability; delta is taken from the latest chunk).
  const emittedToolIds = new Map<string, TimedItem>();

  for (const be of args.events) {
    if (be.event.type === "RAW") {
      const rawType = (be.event as { event?: { type?: string } }).event?.type;
      if (rawType && HIDDEN_PAYLOAD_TYPES.has(rawType)) continue;
    }

    // TOOL_CALL_RESULT events are folded into the matching tool RenderItem
    // (emitted by the chunk path below). Skip emitting them as standalone
    // items — the renderer no longer has a case for TOOL_CALL_RESULT.
    if (be.event.type === EventType.TOOL_CALL_RESULT) continue;

    if (be.event.type === EventType.TOOL_CALL_CHUNK) {
      const chunk = be.event as ToolCallChunkEvent;
      const toolCallId = chunk.toolCallId;
      if (toolCallId && emittedToolIds.has(toolCallId)) {
        // Streaming continuation: overwrite the existing item's chunk so the
        // last delta wins. ts and id stay pinned to the first chunk.
        const existing = emittedToolIds.get(toolCallId)!;
        if (existing.item.tag === "tool") {
          existing.item.chunk = chunk;
        }
        continue;
      }
      const id = `evt:${be.daemon_id}:${be.session_id}:${be.jsonl_offset}:${be.event_index}`;
      const result = toolCallId ? resultsByToolId.get(toolCallId) : undefined;
      const item: TimedItem = {
        tsMs: be.ts,
        rank: 0,
        offset: be.jsonl_offset,
        item: { tag: "tool", id, ts: be.ts, chunk, result },
      };
      buf.push(item);
      if (toolCallId) emittedToolIds.set(toolCallId, item);
      continue;
    }

    buf.push({
      tsMs: be.ts,
      rank: 0,
      offset: be.jsonl_offset,
      item: {
        tag: "agui",
        id: `evt:${be.daemon_id}:${be.session_id}:${be.jsonl_offset}:${be.event_index}`,
        ts: be.ts,
        event: be.event,
      },
    });
  }

  for (const r of args.resolved) {
    const ts = (r as { ts?: number }).ts ?? Date.now();
    buf.push({
      tsMs: ts,
      rank: 3,
      offset: Number.MAX_SAFE_INTEGER,
      item: {
        tag: "permission-resolved",
        id: `perm-resolved:${r.request_id}`,
        ts,
        resolved: r,
      },
    });
  }

  // Sort key:
  //   1. tsMs — but ts=0 events (FSM RUN_* markers, history rows without
  //      `timestamp`) collapse to a single bucket regardless of when they
  //      "happened" in real wall-clock terms.
  //   2. rank — permissions break ties against same-ts events.
  //   3. offset — stable JSONL order for ts=0 items so they don't all
  //      pile up at "1970-01-01" and lose their relative order.
  //
  // For ts=0 items specifically, we want them to sort *next to* their
  // surrounding real-ts events, not at the very top. The simplest
  // approximation that keeps mergeTimeline pure & cheap: treat ts=0
  // as "equal for primary key purposes" and let `offset` carry the
  // weight. Real-ts items with positive ts always win over ts=0 items
  // with smaller offsets — but those should only happen for synthetic
  // FSM markers that the renderer hides anyway, so user-visible damage
  // is nil.
  buf.sort((a, b) => a.tsMs - b.tsMs || a.rank - b.rank || a.offset - b.offset);
  return buf.map((t) => t.item);
}
