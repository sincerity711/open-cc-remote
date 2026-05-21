import { ChevronRight, Code2, ShieldAlert, ShieldCheck, Terminal } from "lucide-react";
import type React from "react";
import { Button } from "../../components/ui/button";
import { CatalogCard } from "./cards/CatalogCard";
import { CatalogHeader } from "./cards/CatalogHeader";
import { UserBubbleSurface } from "./cards/UserBubble";
import { SessionTimelineItem, type TimelineMarker } from "./SessionTimelineItem";
import type { TimelineEvent } from "./types";

export interface RenderTimelineItemContext {
  /** Called when the user taps "Review" on an inline permission card. */
  onOpenPermission?: (request_id: string) => void;
}

/**
 * Pure mapping from a `TimelineEvent` to a `SessionTimelineItem` wrapping the right card body.
 * Per spec §1 invariant 2:
 *   user                                          → marker: user
 *   assistant, thinking                           → marker: claude
 *   tool, permission-inline, subagent, batch,
 *     task(status=created)                        → marker: tool
 *   permission-resolved, task(status=completed)   → marker: success
 *   system, compact, session-boundary, metadata,
 *     error, raw                                  → marker: idle
 */
export function renderTimelineItem(
  event: TimelineEvent,
  ctx: RenderTimelineItemContext = {},
): React.ReactElement {
  const marker = pickMarker(event);

  switch (event.kind) {
    case "user":
      return (
        <SessionTimelineItem key={event.id} marker={marker} meta={event.time} title={event.title}>
          <CatalogCard>
            <UserBubbleBodyLive body={event.body} time={event.time} />
          </CatalogCard>
        </SessionTimelineItem>
      );

    case "assistant":
      return (
        <SessionTimelineItem key={event.id} marker={marker}>
          <CatalogCard>
            <CatalogHeader icon={Terminal} title={event.title} meta={event.time} />
            <p className="mt-2 leading-5 whitespace-pre-wrap">{event.body}</p>
          </CatalogCard>
        </SessionTimelineItem>
      );

    case "permission-inline":
      return (
        <SessionTimelineItem key={event.id} marker={marker}>
          <CatalogCard tone="warning">
            <CatalogHeader icon={ShieldAlert} title="Permission required" tone="warning" />
            <div className="mt-3 grid gap-1 text-xs">
              <p>
                Tool <span className="ml-6 font-mono">{event.tool}</span>
              </p>
              <p>
                Command <span className="font-mono">{event.command}</span>
              </p>
            </div>
            <Button
              className="mt-3 w-full"
              size="sm"
              variant="secondary"
              onClick={() => ctx.onOpenPermission?.(stripPermPrefix(event.id))}
            >
              Review
            </Button>
          </CatalogCard>
        </SessionTimelineItem>
      );

    case "permission-resolved":
      return (
        <SessionTimelineItem key={event.id} marker={marker}>
          <CatalogCard tone={event.decision === "allowed" ? "success" : "danger"}>
            <CatalogHeader
              icon={ShieldCheck}
              title={
                event.decision === "allowed"
                  ? "Permission granted"
                  : event.decision === "denied"
                    ? "Permission denied"
                    : "Permission expired"
              }
              tone={event.decision === "allowed" ? "success" : "danger"}
            />
            <p className="text-muted-foreground mt-2 text-xs">via {event.via}</p>
          </CatalogCard>
        </SessionTimelineItem>
      );

    case "raw":
      return (
        <SessionTimelineItem key={event.id} marker={marker}>
          <CatalogCard>
            <CatalogHeader icon={Code2} title={event.title} />
            <pre className="bg-muted mt-3 max-h-40 overflow-auto rounded-md p-2 font-mono text-xs leading-5">
              {event.json}
            </pre>
            <div className="mt-3 flex items-center justify-between">
              <span className="text-primary text-xs font-semibold">Raw payload</span>
              <ChevronRight className="text-muted-foreground size-4" />
            </div>
          </CatalogCard>
        </SessionTimelineItem>
      );

    default:
      // Future kinds (thinking / tool / subagent / batch / task / system / error)
      // are produced by mergeTimeline upgrades. Render a minimal raw shell so an
      // unhandled kind never crashes the timeline.
      return (
        <SessionTimelineItem key={event.id} marker={marker}>
          <CatalogCard>
            <CatalogHeader icon={Code2} title={event.kind} />
          </CatalogCard>
        </SessionTimelineItem>
      );
  }
}

function pickMarker(event: TimelineEvent): TimelineMarker {
  switch (event.kind) {
    case "user":
      return "user";
    case "assistant":
    case "thinking":
      return "claude";
    case "tool":
    case "permission-inline":
    case "subagent":
    case "batch":
      return "tool";
    case "task":
      return event.status === "completed" ? "success" : "tool";
    case "permission-resolved":
      return "success";
    case "system":
    case "compact":
    case "session-boundary":
    case "metadata":
    case "error":
    case "raw":
      return "idle";
  }
}

function UserBubbleBodyLive({ body, time }: { body: string; time: string }) {
  return (
    <div className="bg-primary-subtle border-primary/20 ml-auto max-w-[92%] rounded-md border p-3">
      <p className="whitespace-pre-wrap">{body}</p>
      {time && (
        <p className="text-muted-foreground mt-2 text-right text-xs">{time}</p>
      )}
    </div>
  );
}

function stripPermPrefix(id: string): string {
  return id.startsWith("perm:") ? id.slice("perm:".length) : id;
}

// Keep `UserBubbleSurface` re-export shape stable for tooling/imports.
export { UserBubbleSurface };
