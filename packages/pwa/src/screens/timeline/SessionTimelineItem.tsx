import type React from "react";

/**
 * Marker types are still tracked because some callers (catalog tiles in
 * the demo, RenderItem dispatch) still classify by them. But we **no
 * longer render a vertical rail** — chat-style timelines (Slack,
 * Claude.ai, ChatGPT, iMessage) use inline avatars next to the message,
 * not a vertical spine. The rail conflated "audit log" with
 * "conversation" and made the layout half-this, half-that.
 *
 * Identity now lives in:
 *   - assistant bubbles → inline ClaudeAvatar to the left of the bubble
 *   - user bubbles      → right-alignment + primary tint
 *   - tool cards        → strong icon in the card header
 *   - status events     → tone on the card (success/danger/warning)
 */
export type TimelineMarker =
  | "user"
  | "claude"
  | "tool"
  | "success"
  | "warning"
  | "error"
  | "idle";

export type TimelineAlign = "start" | "end";

/**
 * Thin spacing wrapper. The marker prop is accepted but no longer drawn —
 * kept on the type so existing call sites compile. Spacing is owned by
 * the parent timeline list (gap-y).
 */
export function SessionTimelineItem({
  align = "start",
  children,
}: {
  align?: TimelineAlign;
  children: React.ReactNode;
  /** Accepted but unused — see file docstring. */
  marker?: TimelineMarker;
}) {
  return (
    <div className={align === "end" ? "flex justify-end" : "min-w-0"}>
      <div className="min-w-0 max-w-full">{children}</div>
    </div>
  );
}
