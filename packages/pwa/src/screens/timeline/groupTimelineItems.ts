import type { RenderItem } from "./types";

/**
 * Output of the grouping pass — what the timeline actually renders.
 *
 * Strategy: collapse runs of consecutive `tool` items into a single
 * `tool-group` so the chat surface stays conversational. Failed tools
 * stay in the group too — the group header surfaces the failure count
 * so the user can decide whether to expand and inspect. (Earlier draft
 * pulled failed tools out as siblings, but that broke the temporal
 * adjacency the user came in expecting; e.g. "Claude ran 4 commands"
 * should still mean 4 commands even if one failed.)
 *
 * Single tools also become a 1-element `tool-group` so the visual
 * treatment is identical and the user always gets the same affordance
 * to expand. The group header text degrades to "Ran 1 command" for
 * the singleton case.
 *
 * Everything else (chat, permission-resolved, …) passes through as
 * `single`.
 */
export type TimelineGroup =
  | { kind: "single"; item: RenderItem }
  | { kind: "tool-group"; id: string; items: RenderItem[] };

export function groupTimelineItems(items: RenderItem[]): TimelineGroup[] {
  const out: TimelineGroup[] = [];
  let buffer: RenderItem[] = [];

  const flush = () => {
    if (buffer.length === 0) return;
    out.push({
      kind: "tool-group",
      // Stable id for the group: first tool's id ensures React keys are
      // consistent across re-renders even as more tools land.
      id: `group-${buffer[0]!.id}`,
      items: buffer,
    });
    buffer = [];
  };

  for (const item of items) {
    if (item.tag === "tool") {
      buffer.push(item);
    } else {
      flush();
      out.push({ kind: "single", item });
    }
  }
  flush();
  return out;
}
