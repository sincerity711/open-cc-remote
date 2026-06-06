import type React from "react";
import { renderTimelineItem } from "./renderTimelineItem";
import { ToolGroup } from "./ToolGroup";
import type { TimelineGroup } from "./groupTimelineItems";
import type { ReasoningStatus } from "../../lib/reasoning-status";

/**
 * Dispatch a grouped timeline element to the right surface.
 *
 *   - tool-group → collapsible ToolGroup card
 *   - single     → existing per-item renderer (chat bubble, permission, …)
 *
 * Keeping ToolGroup off the per-item renderer means the existing dispatch
 * logic (markers, AGUIEvent type switch, permission tone) stays untouched.
 *
 * `reasoningStatus` is forwarded to per-item rendering so the
 * `ReasoningCard` knows whether to show its active spinner or its frozen
 * "Thought" summary. Optional — DemoApp call sites that don't compute a
 * status map default the card to "active".
 */
export function renderTimelineGroup(
  group: TimelineGroup,
  reasoningStatus?: Map<string, ReasoningStatus>,
): React.ReactElement {
  if (group.kind === "tool-group") {
    return (
      <ToolGroup
        key={group.id}
        id={group.id}
        items={group.items.map((it) => {
          // Narrow: groupTimelineItems only puts `tool` items into a group.
          if (it.tag !== "tool") {
            throw new Error(`tool-group contained non-tool item: ${it.tag}`);
          }
          return { id: it.id, chunk: it.chunk, result: it.result };
        })}
      />
    );
  }
  return renderTimelineItem(group.item, reasoningStatus);
}
