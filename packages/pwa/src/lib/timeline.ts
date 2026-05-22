import type {
  EventFrameForPwa,
  PwaChatBroadcast,
  PwaPermissionRequest,
  PwaPermissionResolved,
} from "@cc-remote/proto";
import type { TimelineEvent } from "../screens/timeline/types";

export interface MergeTimelineArgs {
  events: EventFrameForPwa[];
  chat: PwaChatBroadcast[];
  pending: PwaPermissionRequest[];
  resolved: PwaPermissionResolved[];
}

interface TimedItem {
  /** Unix milliseconds — the sole ordering key for the merged timeline. */
  tsMs: number;
  /** Tiebreaker for stable ordering when timestamps collide (e.g. chat and event in the same ms). */
  rank: number;
  item: TimelineEvent;
}

/**
 * Pure derivation of the visible timeline from the four hub-state slices for one session.
 * Output is sorted by timestamp; ids are deterministic.
 */
export function mergeTimeline(args: MergeTimelineArgs): TimelineEvent[] {
  const buf: TimedItem[] = [];

  // Chat broadcasts → user / assistant. Chat ts is unix seconds (per @cc-remote/proto).
  for (const m of args.chat) {
    const tsMs = m.ts * 1000;
    buf.push({
      tsMs,
      rank: 0,
      item: {
        id: `chat:${m.message_id}`,
        kind: m.from === "pwa" ? "user" : "assistant",
        title: m.from === "pwa" ? (m.user ?? "You") : "Claude",
        body: m.content,
        time: formatClockTime(tsMs),
      },
    });
  }

  // EventFrameForPwa → raw fallback (v1).
  // ts is unix milliseconds when populated by the daemon. History-replayed events
  // arrive with ts === 0; fall back to jsonl_offset for stable ordering.
  for (const e of args.events) {
    const tsMs = e.ts > 0 ? e.ts : 0;
    const payloadType = extractPayloadType(e.payload);
    // Chat broadcasts already render user/assistant turns as friendly bubbles.
    // The JSONL stream echoes them; skip the duplicates.
    if (payloadType === "user" || payloadType === "assistant") continue;
    buf.push({
      tsMs,
      rank: e.jsonl_offset,
      item: {
        id: `event:${e.jsonl_offset}`,
        kind: "raw",
        title: payloadType,
        json: safeStringify(e.payload),
      },
    });
  }

  // Pending permission requests → permission-inline.
  // expires_at is unix seconds (per @cc-remote/proto).
  for (const p of args.pending) {
    const tsMs = p.expires_at * 1000;
    buf.push({
      tsMs,
      rank: 0,
      item: {
        id: `perm:${p.request_id}`,
        kind: "permission-inline",
        tool: p.tool,
        command: p.args_summary,
        risk: "warning",
      },
    });
  }

  // Resolved permissions → permission-resolved. The protocol carries no ts
  // on the resolved frame, so we sort them after pending requests via a high
  // rank — the live UI will mostly receive these one at a time anyway.
  for (const r of args.resolved) {
    buf.push({
      tsMs: 0,
      rank: Number.MAX_SAFE_INTEGER,
      item: {
        id: `perm-res:${r.request_id}`,
        kind: "permission-resolved",
        decision: mapDecision(r.decision),
        via: r.decided_via,
        time: "",
      },
    });
  }

  buf.sort((a, b) => (a.tsMs - b.tsMs) || (a.rank - b.rank));
  return buf.map((b) => b.item);
}

function extractPayloadType(payload: unknown): string {
  if (
    payload !== null &&
    typeof payload === "object" &&
    "type" in payload &&
    typeof (payload as { type: unknown }).type === "string"
  ) {
    return (payload as { type: string }).type;
  }
  return "event";
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "{}";
  }
}

function mapDecision(
  d: PwaPermissionResolved["decision"],
): "allowed" | "denied" | "expired" {
  if (d === "allow") return "allowed";
  if (d === "deny") return "denied";
  return "expired";
}

function formatClockTime(tsMs: number): string {
  if (tsMs <= 0) return "";
  const date = new Date(tsMs);
  const h = date.getHours();
  const m = date.getMinutes().toString().padStart(2, "0");
  const period = h >= 12 ? "PM" : "AM";
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:${m} ${period}`;
}
