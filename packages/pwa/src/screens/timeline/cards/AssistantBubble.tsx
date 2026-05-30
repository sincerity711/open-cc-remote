import type { TextMessageChunkEvent } from "@cc-remote/proto";
import { EventType } from "@cc-remote/proto";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChatBubble } from "../../primitives/ChatBubble";
import { ClaudeAvatar } from "../../primitives/ClaudeAvatar";

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
 * Live assistant message rendered as a left-aligned chat bubble with the
 * Claude brand mark inline to the left — chat-first pattern (Slack /
 * Discord / iMessage / Claude.ai). The earlier vertical-rail layout has
 * been removed; identity now travels with the bubble itself rather than
 * via a column glyph.
 *
 * Body is rendered as GitHub-flavored markdown so headings, code blocks,
 * lists, tables etc. from Claude's output don't show up as literal `##` /
 * backticks.
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
    <div className="flex items-start gap-2.5">
      <ClaudeAvatar size="sm" className="mt-1.5" />
      <div className="min-w-0 flex-1">
        <ChatBubble align="start" tone="neutral">
          <div className="prose prose-sm dark:prose-invert max-w-none break-words [&_pre]:bg-code [&_pre]:text-code-foreground [&_code]:font-mono">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {event.delta ?? ""}
            </ReactMarkdown>
          </div>
          <p className="text-tertiary-foreground mt-1 text-[11px]">{time}</p>
        </ChatBubble>
      </div>
    </div>
  );
}
