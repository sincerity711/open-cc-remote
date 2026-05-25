import type { AGUIEvent, PwaPermissionRequest, PwaPermissionResolved, PwaChatBroadcast } from "@cc-remote/proto";

/**
 * What the timeline renderer consumes — a thin sum of:
 *   - AG-UI session events (the bulk),
 *   - control-class items that aren't AG-UI (chat broadcasts, permission
 *     requests/resolutions).
 *
 * Render dispatch keys off the `tag` and, for `agui` items, off `event.type`.
 */
export type RenderItem =
  | { tag: "agui"; id: string; ts: number; event: AGUIEvent }
  | { tag: "chat"; id: string; ts: number; chat: PwaChatBroadcast }
  | { tag: "permission-inline"; id: string; ts: number; pending: PwaPermissionRequest }
  | { tag: "permission-resolved"; id: string; ts: number; resolved: PwaPermissionResolved };
