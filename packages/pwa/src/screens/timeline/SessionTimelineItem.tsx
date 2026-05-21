import { CheckCircle2, Clock, MessageSquare, Wrench } from "lucide-react";
import type React from "react";
import { cn } from "../../lib/utils";
import { ClaudeCodeMark } from "../primitives/ClaudeCodeMark";

export type TimelineMarker = "claude" | "idle" | "success" | "tool" | "user";

export function SessionTimelineItem({
  children,
  meta,
  marker,
  title,
}: {
  children: React.ReactNode;
  marker: TimelineMarker;
  meta?: string;
  title?: string;
}) {
  return (
    <div className="relative mb-4">
      <span
        className={cn(
          "absolute -left-8 top-0 z-10 flex size-7 items-center justify-center rounded-full border",
          marker === "claude" && "border-orange-200 bg-orange-50",
          marker === "idle" && "border-border bg-muted",
          marker === "success" && "border-primary/25 bg-primary text-primary-foreground",
          marker === "tool" && "border-border bg-muted",
          marker === "user" && "border-primary/25 bg-primary-subtle",
        )}
      >
        {marker === "claude" ? (
          <ClaudeCodeMark className="rounded-full" size="sm" />
        ) : marker === "user" ? (
          <MessageSquare className="text-primary size-3.5" />
        ) : marker === "success" ? (
          <CheckCircle2 className="size-3.5" />
        ) : marker === "idle" ? (
          <Clock className="text-muted-foreground size-3.5" />
        ) : (
          <Wrench className="text-muted-foreground size-3.5" />
        )}
      </span>
      <div className="min-w-0">
        {title && (
          <div className="mb-2 flex items-center gap-2">
            <p className="text-sm font-semibold">{title}</p>
            {meta && <span className="text-muted-foreground text-xs">{meta}</span>}
          </div>
        )}
        <div className="space-y-2">{children}</div>
      </div>
    </div>
  );
}
