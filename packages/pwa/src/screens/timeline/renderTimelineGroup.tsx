import type React from "react";
import { renderTimelineItem, type RenderTimelineCtx } from "./renderTimelineItem";
import { ToolGroup } from "./ToolGroup";
import type { TimelineGroup } from "./groupTimelineItems";

/**
 * Dispatch a grouped timeline element to the right surface.
 *
 *   - tool-group → collapsible ToolGroup card
 *   - single     → existing per-item renderer (chat bubble, permission, …)
 *
 * `ctx` is forwarded to single-item renders. It carries sticky histories
 * (resolved permission/ask cards) and per-item reasoning status (so
 * ReasoningCard knows whether to show its active spinner or its frozen
 * "Thought" summary). Tool groups don't need it. Optional — call sites
 * that don't compute a status map / history default to placeholders.
 */
export function renderTimelineGroup(
  group: TimelineGroup,
  ctx?: RenderTimelineCtx,
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
  return renderTimelineItem(group.item, ctx);
}
