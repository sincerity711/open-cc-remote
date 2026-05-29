import type {
  AGUIEvent,
  PwaPermissionResolved,
  ToolCallChunkEvent,
  ToolCallResultEvent,
} from "@cc-remote/proto";

/**
 * What the timeline renderer consumes — a thin sum of:
 *   - AG-UI session events (the bulk),
 *   - a synthetic `tool` item that pairs a TOOL_CALL_CHUNK with its
 *     (optionally-still-pending) TOOL_CALL_RESULT so the UI shows one card,
 *   - control-class items that aren't AG-UI (permission requests/resolutions).
 *
 * Render dispatch keys off the `tag` and, for `agui` items, off `event.type`.
 *
 * Chat broadcasts are intentionally NOT a RenderItem variant: the daemon's
 * JSONL playback emits an authoritative TEXT_MESSAGE_CHUNK (role=user) for
 * every message the user sent, so rendering the hub's chat broadcast in
 * parallel produced a duplicate user bubble. Hub still broadcasts chat for
 * multi-PWA sync, but those frames feed `useHub.chatMessages` for non-timeline
 * uses (e.g. badging) and do not enter the timeline.
 */
export type RenderItem =
  | { tag: "agui"; id: string; ts: number; event: AGUIEvent }
  | {
      tag: "tool";
      id: string;
      ts: number;
      chunk: ToolCallChunkEvent;
      result?: ToolCallResultEvent;
    }
  | { tag: "permission-resolved"; id: string; ts: number; resolved: PwaPermissionResolved };
