import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Circle,
  Wrench,
} from "lucide-react";
import type React from "react";
import { cn } from "../../lib/utils";
import { ClaudeCodeMark } from "../primitives/ClaudeCodeMark";

/**
 * Per docs/design/light-timeline.png the rail icon is a *small glyph* whose
 * sole job is to scan event type / status. User bubbles do NOT use this
 * component — they render standalone and right-aligned (chat layout) without
 * a rail attachment.
 *
 *   claude     → Claude mark
 *   tool       → wrench (generic)
 *   success    → green check
 *   warning    → amber triangle (permission needed / open caveat)
 *   error      → red alert
 *   idle       → empty circle (low-noise system events)
 */
export type TimelineMarker =
  | "claude"
  | "tool"
  | "success"
  | "warning"
  | "error"
  | "idle";

export function SessionTimelineItem({
  children,
  marker,
}: {
  children: React.ReactNode;
  marker: TimelineMarker;
}) {
  return (
    <div className="relative mb-4">
      <span
        className={cn(
          "absolute -left-7 top-2 z-10 flex size-5 items-center justify-center",
        )}
      >
        {marker === "claude" && <ClaudeCodeMark className="rounded-full" size="sm" />}
        {marker === "tool" && <Wrench className="text-muted-foreground size-3.5" />}
        {marker === "success" && <CheckCircle2 className="text-success size-3.5" />}
        {marker === "warning" && <AlertTriangle className="text-warning size-3.5" />}
        {marker === "error" && <AlertCircle className="text-danger size-3.5" />}
        {marker === "idle" && (
          <Circle className="text-muted-foreground size-2.5" strokeWidth={2} />
        )}
      </span>
      <div className="min-w-0 space-y-2">{children}</div>
    </div>
  );
}
