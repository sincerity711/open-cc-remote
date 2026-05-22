import { Check } from "lucide-react";
import { ChatBubble } from "../../primitives/ChatBubble";

export type UserBubbleStatus = "sending" | "sent" | "failed";

/** Static demo bubble (kept for /demo & catalog preview). */
export function UserBubble() {
  return (
    <UserBubbleLive
      body="Please add password reset flow using email tokens."
      time="10:24 AM"
    />
  );
}

export function UserBubbleSurface() {
  return <UserBubble />;
}

/**
 * Live user message rendered as a right-aligned chat bubble. Per the chat /
 * workflow split: no header, no rail glyph (the row hides the marker — the
 * timeline rail line still passes behind). Card chrome belongs to workflow
 * events (`tool` / `permission` / `failure` / `task`), not chat.
 */
export function UserBubbleLive({
  body,
  status = "sent",
  time,
}: {
  body: string;
  status?: UserBubbleStatus;
  time: string;
}) {
  return (
    <ChatBubble align="end" tone="primary">
      <p className="whitespace-pre-wrap">{body}</p>
      <div className="text-muted-foreground mt-1 flex items-center justify-end gap-1 text-[11px]">
        <span>{time}</span>
        {status === "sent" && <Check className="size-3" />}
        {status === "failed" && <span className="text-danger font-medium">failed</span>}
      </div>
    </ChatBubble>
  );
}
