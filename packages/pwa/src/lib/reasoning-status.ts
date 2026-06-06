import { EventType, type AGUIEvent } from "@cc-remote/proto";
import type { RenderItem } from "../screens/timeline/types";

export type ReasoningStatus = "active" | "done";

/**
 * For each `REASONING_MESSAGE_CHUNK` RenderItem in `items`, returns "done"
 * if any later item is a "real" non-reasoning item (text / tool /
 * permission / run-error / raw), else "active".
 *
 * FSM markers (`RUN_STARTED` / `RUN_FINISHED`), `ACTIVITY_*`, `STATE_DELTA`
 * and *other* reasoning items do NOT flip status — they're invisible glue.
 *
 * Single backward pass — `O(n)`. The selector runs at render time so that
 * `mergeTimeline` stays pure: status is a property of the timeline tail,
 * not the event itself.
 */
export function computeReasoningStatus(
  items: RenderItem[],
): Map<string, ReasoningStatus> {
  const status = new Map<string, ReasoningStatus>();
  let seenFlipper = false;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (isReasoning(item)) {
      status.set(item.id, seenFlipper ? "done" : "active");
      continue;
    }
    if (isFlipper(item)) {
      seenFlipper = true;
    }
  }
  return status;
}

function isReasoning(item: RenderItem): boolean {
  return (
    item.tag === "agui" &&
    (item.event as AGUIEvent).type === EventType.REASONING_MESSAGE_CHUNK
  );
}

function isFlipper(item: RenderItem): boolean {
  if (item.tag === "tool") return true;
  if (item.tag === "permission-resolved") return true;
  if (item.tag !== "agui") return false;
  switch (item.event.type) {
    case EventType.TEXT_MESSAGE_CHUNK:
    case EventType.RUN_ERROR:
    case EventType.RAW:
      return true;
    default:
      // RUN_STARTED, RUN_FINISHED, ACTIVITY_SNAPSHOT, ACTIVITY_DELTA,
      // STATE_DELTA, REASONING_MESSAGE_CHUNK — invisible glue.
      return false;
  }
}
