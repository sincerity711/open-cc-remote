import type { TextMessageChunkEvent } from "@cc-remote/proto";
import { EventType } from "@cc-remote/proto";
import { ChatBubble } from "../../primitives/ChatBubble";

/** Static demo bubble (kept for /demo & catalog preview). */
export function AssistantBubble() {
  return (
    <AssistantBubbleLive
      event={{
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "demo",
        role: "assistant",
        delta: "I'll plan the implementation.",
      } as TextMessageChunkEvent}
      ts={Date.now()}
    />
  );
}

/**
 * Live assistant message rendered as a left-aligned chat bubble. Identity
 * (Claude mark) is carried by the timeline rail glyph, so the bubble itself
 * has no header / no avatar — just text + a quiet timestamp.
 */
export function AssistantBubbleLive({
  event,
  ts,
}: {
  event: TextMessageChunkEvent;
  ts: number;
}) {
  const time = new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return (
    <ChatBubble align="start" tone="neutral">
      <p className="whitespace-pre-wrap">{event.delta ?? ""}</p>
      <p className="text-muted-foreground mt-1 text-[11px]">{time}</p>
    </ChatBubble>
  );
}
