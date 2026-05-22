import {
  ChevronRight,
  type LucideIcon,
  Pencil,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  FileText,
} from "lucide-react";
import { useState } from "react";
import type React from "react";
import { Button } from "../../components/ui/button";
import { CatalogCard, type CatalogCardTone } from "./cards/CatalogCard";
import { CatalogHeader } from "./cards/CatalogHeader";
import { AssistantBubbleLive } from "./cards/AssistantBubble";
import { UserBubbleLive } from "./cards/UserBubble";
import { SessionTimelineItem, type TimelineMarker } from "./SessionTimelineItem";
import type { TimelineEvent } from "./types";

export interface RenderTimelineItemContext {
  /** Called when the user taps "Review" on an inline permission card. */
  onOpenPermission?: (request_id: string) => void;
}

/**
 * Pure mapping from a `TimelineEvent` → React node. Per docs/design/light-timeline.png:
 *   - Every event sits on the rail. The rail glyph = type/status; the card
 *     icon = tool identity (only when strong, e.g. Bash/Edit/Read).
 *   - User messages share the same shape as Claude messages — only the card
 *     tone differs (`purple` vs default) so they read like a chat bubble.
 */
export function renderTimelineItem(
  event: TimelineEvent,
  ctx: RenderTimelineItemContext = {},
): React.ReactElement {
  const marker = pickMarker(event);

  switch (event.kind) {
    case "user":
      return (
        <SessionTimelineItem key={event.id} align="end" marker={marker}>
          <UserBubbleLive body={event.body} time={event.time} />
        </SessionTimelineItem>
      );

    case "assistant":
      return (
        <SessionTimelineItem key={event.id} marker={marker}>
          <AssistantBubbleLive body={event.body} time={event.time} />
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
            <CatalogHeader title={event.title} />
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

    case "tool":
      return (
        <SessionTimelineItem key={event.id} marker={marker}>
          <ToolCardLive event={event} />
        </SessionTimelineItem>
      );

    case "thinking":
      return (
        <SessionTimelineItem key={event.id} marker={marker}>
          <CatalogCard>
            <CatalogHeader title="Reasoning" />
            <p className="mt-2 text-sm leading-5 whitespace-pre-wrap">
              {event.body || "(no reasoning text)"}
            </p>
          </CatalogCard>
        </SessionTimelineItem>
      );

    default:
      // Future kinds are produced by mergeTimeline upgrades. Render a minimal
      // raw shell so an unhandled kind never crashes the timeline.
      return (
        <SessionTimelineItem key={event.id} marker={marker}>
          <CatalogCard>
            <CatalogHeader title={event.kind} />
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
    case "subagent":
    case "batch":
      return "tool";
    case "task":
      return event.status === "completed" ? "success" : "tool";
    case "permission-inline":
      return "warning";
    case "permission-resolved":
      return event.decision === "denied" || event.decision === "expired"
        ? "error"
        : "success";
    case "system":
    case "compact":
    case "session-boundary":
    case "metadata":
    case "raw":
      return "idle";
    case "error":
      return "error";
  }
}

type ToolEvent = Extract<TimelineEvent, { kind: "tool" }>;

/**
 * Card icons are intentionally narrow — only tools whose identity is strong
 * enough that the rail glyph (`tool`) doesn't carry it. Other tool calls fall
 * through to a no-icon header so they don't double up.
 */
function pickStrongToolIcon(name: string): LucideIcon | undefined {
  if (!name) return undefined;
  if (name === "Bash") return Terminal;
  if (name === "Edit" || name === "Write" || name === "MultiEdit") return Pencil;
  if (name === "Read") return FileText;
  return undefined;
}

function ToolCardLive({ event }: { event: ToolEvent }) {
  const [expanded, setExpanded] = useState(false);
  const icon = pickStrongToolIcon(event.tool);
  const cardTone: CatalogCardTone = event.result === "failure" ? "danger" : "default";
  const headerTone =
    event.result === "failure"
      ? ("danger" as const)
      : event.result === "success"
        ? ("success" as const)
        : ("default" as const);

  const statusLabel =
    event.result === "running"
      ? "Active"
      : event.result === "success"
        ? "Success"
        : "Failed";
  const statusClass =
    event.result === "running"
      ? "bg-muted text-muted-foreground"
      : event.result === "success"
        ? "bg-success-subtle text-success border-success/30"
        : "bg-danger-subtle text-danger border-danger/30";

  const outputLines = event.output ? event.output.split("\n") : [];
  const lineCount = outputLines.length;
  const isShort =
    event.result === "success" &&
    !!event.output &&
    lineCount <= 2 &&
    event.output.length <= 200;
  const showExpand =
    !!event.output && (event.result === "failure" || !isShort);

  return (
    <CatalogCard tone={cardTone}>
      <CatalogHeader
        icon={icon}
        title={event.tool || "tool"}
        tone={headerTone}
        status={
          <span
            className={`shrink-0 rounded-md border px-2 py-0.5 text-xs font-medium ${statusClass}`}
          >
            {statusLabel}
          </span>
        }
      />
      {event.command && (
        <pre className="bg-muted mt-2 max-h-32 overflow-auto rounded-md p-2 font-mono text-xs leading-5 whitespace-pre-wrap break-all">
          <code>{event.command}</code>
        </pre>
      )}
      {isShort && (
        <p className="text-muted-foreground mt-2 font-mono text-xs whitespace-pre-wrap">
          {event.output}
        </p>
      )}
      {showExpand && (
        <>
          <Button
            className="mt-2 w-full justify-between"
            size="sm"
            variant="ghost"
            onClick={() => setExpanded((v) => !v)}
          >
            <span>
              {expanded ? "Hide output" : `View output (${lineCount} lines)`}
            </span>
            <ChevronRight
              className={`size-4 transition-transform ${expanded ? "rotate-90" : ""}`}
            />
          </Button>
          {expanded && (
            <pre className="bg-muted mt-2 max-h-60 overflow-auto rounded-md p-2 font-mono text-xs leading-5 whitespace-pre-wrap">
              {event.output}
            </pre>
          )}
        </>
      )}
    </CatalogCard>
  );
}

function stripPermPrefix(id: string): string {
  return id.startsWith("perm:") ? id.slice("perm:".length) : id;
}
