import { Check } from "lucide-react";
import type { TextMessageChunkEvent } from "@cc-remote/proto";
import { EventType } from "@cc-remote/proto";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChatBubble } from "../../primitives/ChatBubble";

export type UserBubbleStatus = "sending" | "sent" | "failed";

/** Static demo bubble (kept for /demo & catalog preview). */
export function UserBubble() {
  return (
    <UserBubbleLive
      event={{
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "demo",
        role: "user",
        delta: "Please add password reset flow using email tokens.",
      } as TextMessageChunkEvent}
      ts={Date.now()}
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
 *
 * Body is rendered as GitHub-flavored markdown — most user prompts are plain
 * text, but power users send pasted snippets that benefit from code-fence
 * rendering, and we want symmetry with assistant bubbles.
 */
export function UserBubbleLive({
  event,
  status = "sent",
  ts,
}: {
  event: TextMessageChunkEvent;
  status?: UserBubbleStatus;
  ts: number;
}) {
  const time = new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return (
    <ChatBubble align="end" tone="primary">
      <div className="prose prose-sm dark:prose-invert max-w-none break-words [&_pre]:bg-code [&_pre]:text-code-foreground [&_code]:font-mono">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {event.delta ?? ""}
        </ReactMarkdown>
      </div>
      <div className="text-muted-foreground mt-1 flex items-center justify-end gap-1 text-[11px]">
        <span>{time}</span>
        {status === "sent" && <Check className="size-3" />}
        {status === "failed" && <span className="text-danger font-medium">failed</span>}
      </div>
    </ChatBubble>
  );
}
