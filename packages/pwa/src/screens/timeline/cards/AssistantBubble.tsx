import type { TextMessageChunkEvent } from "@cc-remote/proto";
import { EventType } from "@cc-remote/proto";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
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
 *
 * Body is rendered as GitHub-flavored markdown so headings, code blocks,
 * lists, tables etc. from Claude's output don't show up as literal `##` /
 * backticks. The `prose` typography classes give us sane defaults; we
 * override code-block colors to match the rest of the surface (dark code
 * tone is already in styles.css via --code-bg / --code-text).
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
      <div className="prose prose-sm dark:prose-invert max-w-none break-words [&_pre]:bg-code [&_pre]:text-code-foreground [&_code]:font-mono">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {event.delta ?? ""}
        </ReactMarkdown>
      </div>
      <p className="text-muted-foreground mt-1 text-[11px]">{time}</p>
    </ChatBubble>
  );
}
