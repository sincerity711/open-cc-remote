import { ChatBubble } from "../../primitives/ChatBubble";

/** Static demo bubble (kept for /demo & catalog preview). */
export function AssistantBubble() {
  return (
    <AssistantBubbleLive
      body="I'll plan the implementation and create the necessary endpoints."
      time="10:24 AM"
    />
  );
}

/**
 * Live assistant message rendered as a left-aligned chat bubble. Identity
 * (Claude mark) is carried by the timeline rail glyph, so the bubble itself
 * has no header / no avatar — just text + a quiet timestamp.
 */
export function AssistantBubbleLive({
  body,
  time,
}: {
  body: string;
  time: string;
}) {
  return (
    <ChatBubble align="start" tone="neutral">
      <p className="whitespace-pre-wrap">{body}</p>
      <p className="text-muted-foreground mt-1 text-[11px]">{time}</p>
    </ChatBubble>
  );
}
