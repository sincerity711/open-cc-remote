import type React from "react";
import { cn } from "../../lib/utils";

export type ChatBubbleTone = "neutral" | "primary";
export type ChatBubbleAlign = "start" | "end";

/**
 * Conversational bubble for `chat.user` / `chat.assistant`.
 *
 * Distinct from `CatalogCard` (workflow card): no header, lighter chrome, larger
 * radius, max-width capped so it reads like a chat message rather than a tool
 * event. `tone="primary"` → user (right-aligned, primary-subtle); `tone="neutral"`
 * → assistant (left-aligned, surface + border).
 */
export function ChatBubble({
  align = "start",
  children,
  tone = "neutral",
}: {
  align?: ChatBubbleAlign;
  children: React.ReactNode;
  tone?: ChatBubbleTone;
}) {
  return (
    <div className={cn("flex", align === "end" ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "rounded-bubble max-w-[86%] px-3.5 py-3 text-[15px] leading-snug",
          tone === "primary" && "bg-primary-subtle text-foreground",
          tone === "neutral" && "bg-surface border-border shadow-card border",
        )}
      >
        {children}
      </div>
    </div>
  );
}
