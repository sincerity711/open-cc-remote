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
import {
  EventType,
  type AGUIEvent,
  type ToolCallChunkEvent,
  type ToolCallResultEvent,
  type ReasoningMessageChunkEvent,
  type RawEvent,
  type TextMessageChunkEvent,
} from "@cc-remote/proto";
import { Button } from "../../components/ui/button";
import { CatalogCard, type CatalogCardTone } from "./cards/CatalogCard";
import { CatalogHeader } from "./cards/CatalogHeader";
import { AssistantBubbleLive } from "./cards/AssistantBubble";
import { UserBubbleLive } from "./cards/UserBubble";
import { SessionTimelineItem, type TimelineMarker } from "./SessionTimelineItem";
import type { RenderItem } from "./types";
import { toolStatusFromResult } from "../../lib/view-helpers";

export interface RenderTimelineItemContext {
  onOpenPermission?: (request_id: string) => void;
}

export function renderTimelineItem(
  item: RenderItem,
  ctx: RenderTimelineItemContext = {},
): React.ReactElement {
  const marker = pickMarker(item);

  switch (item.tag) {
    case "permission-inline":
      return (
        <SessionTimelineItem key={item.id} marker={marker}>
          <CatalogCard tone="warning">
            <CatalogHeader icon={ShieldAlert} title="Permission required" tone="warning" />
            <div className="mt-3 grid gap-1 text-xs">
              <p>
                Tool <span className="ml-6 font-mono">{item.pending.tool}</span>
              </p>
            </div>
            <Button
              className="mt-3 w-full"
              size="sm"
              variant="secondary"
              onClick={() => ctx.onOpenPermission?.(item.pending.request_id)}
            >
              Review
            </Button>
          </CatalogCard>
        </SessionTimelineItem>
      );

    case "permission-resolved":
      return (
        <SessionTimelineItem key={item.id} marker={marker}>
          <CatalogCard
            tone={item.resolved.decision === "allow" ? "success" : "danger"}
          >
            <CatalogHeader
              icon={ShieldCheck}
              title={
                item.resolved.decision === "allow"
                  ? "Permission granted"
                  : item.resolved.decision === "deny"
                    ? "Permission denied"
                    : "Permission expired"
              }
              tone={item.resolved.decision === "allow" ? "success" : "danger"}
            />
          </CatalogCard>
        </SessionTimelineItem>
      );

    case "chat":
      return (
        <SessionTimelineItem key={item.id} align="end" marker={marker}>
          <UserBubbleLive
            event={{
              type: EventType.TEXT_MESSAGE_CHUNK,
              messageId: item.id,
              role: "user",
              delta: item.chat.content,
            } as TextMessageChunkEvent}
            ts={item.ts}
          />
        </SessionTimelineItem>
      );

    case "agui":
      return renderAgUi(item.id, item.event, item.ts, marker);
  }
}

function renderAgUi(
  id: string,
  event: AGUIEvent,
  ts: number,
  marker: TimelineMarker,
): React.ReactElement {
  switch (event.type) {
    case EventType.TEXT_MESSAGE_CHUNK: {
      const ev = event as TextMessageChunkEvent;
      if (ev.role === "user") {
        return (
          <SessionTimelineItem key={id} align="end" marker={marker}>
            <UserBubbleLive event={ev} ts={ts} />
          </SessionTimelineItem>
        );
      }
      return (
        <SessionTimelineItem key={id} marker={marker}>
          <AssistantBubbleLive event={ev} ts={ts} />
        </SessionTimelineItem>
      );
    }

    case EventType.REASONING_MESSAGE_CHUNK: {
      const ev = event as ReasoningMessageChunkEvent;
      return (
        <SessionTimelineItem key={id} marker={marker}>
          <CatalogCard>
            <CatalogHeader title="Reasoning" />
            <p className="mt-2 text-sm leading-5 whitespace-pre-wrap">
              {ev.delta ?? "(no reasoning text)"}
            </p>
          </CatalogCard>
        </SessionTimelineItem>
      );
    }

    case EventType.TOOL_CALL_CHUNK: {
      const ev = event as ToolCallChunkEvent;
      return (
        <SessionTimelineItem key={id} marker={marker}>
          <ToolChunkCard event={ev} ts={ts} />
        </SessionTimelineItem>
      );
    }

    case EventType.TOOL_CALL_RESULT: {
      const ev = event as ToolCallResultEvent;
      return (
        <SessionTimelineItem key={id} marker={marker}>
          <ToolResultCard event={ev} />
        </SessionTimelineItem>
      );
    }

    case EventType.RUN_STARTED:
    case EventType.RUN_FINISHED:
      // FSM markers — not rendered as cards in v1; SessionView shows
      // working/idle state via the daemon view model.
      return <></>;

    case EventType.RUN_ERROR: {
      const msg = (event as { message?: string }).message ?? "Run error";
      return (
        <SessionTimelineItem key={id} marker={marker}>
          <CatalogCard tone="danger">
            <CatalogHeader title="Run error" tone="danger" />
            <p className="mt-2 text-xs">{msg}</p>
          </CatalogCard>
        </SessionTimelineItem>
      );
    }

    case EventType.RAW: {
      const ev = event as RawEvent;
      return (
        <SessionTimelineItem key={id} marker={marker}>
          <CatalogCard>
            <CatalogHeader title="Raw event" />
            <pre className="bg-muted mt-3 max-h-40 overflow-auto rounded-md p-2 font-mono text-xs leading-5">
              {JSON.stringify((ev as { event?: unknown }).event, null, 2)}
            </pre>
          </CatalogCard>
        </SessionTimelineItem>
      );
    }

    default:
      return (
        <SessionTimelineItem key={id} marker={marker}>
          <CatalogCard>
            <CatalogHeader title={String(event.type)} />
          </CatalogCard>
        </SessionTimelineItem>
      );
  }
}

function pickMarker(item: RenderItem): TimelineMarker {
  if (item.tag === "permission-inline") return "warning";
  if (item.tag === "permission-resolved") {
    return item.resolved.decision === "deny" || item.resolved.decision === "expired"
      ? "error"
      : item.resolved.decision === "terminal"
        ? "error"
        : "success";
  }
  if (item.tag === "chat") return "user";
  switch (item.event.type) {
    case EventType.TEXT_MESSAGE_CHUNK:
      return (item.event as TextMessageChunkEvent).role === "user" ? "user" : "claude";
    case EventType.REASONING_MESSAGE_CHUNK:
      return "claude";
    case EventType.TOOL_CALL_CHUNK:
    case EventType.TOOL_CALL_RESULT:
    case EventType.ACTIVITY_SNAPSHOT:
    case EventType.ACTIVITY_DELTA:
      return "tool";
    case EventType.RUN_ERROR:
      return "error";
    default:
      return "idle";
  }
}

function pickStrongToolIcon(name: string): LucideIcon | undefined {
  if (!name) return undefined;
  if (name === "Bash") return Terminal;
  if (name === "Edit" || name === "Write" || name === "MultiEdit") return Pencil;
  if (name === "Read") return FileText;
  return undefined;
}

function ToolChunkCard({ event, ts: _ts }: { event: ToolCallChunkEvent; ts: number }) {
  const name = event.toolCallName ?? "tool";
  const icon = pickStrongToolIcon(name);
  const args = event.delta ?? "";
  return (
    <CatalogCard>
      <CatalogHeader
        icon={icon}
        title={name}
        status={
          <span className="bg-muted text-muted-foreground rounded-md border px-2 py-0.5 text-xs font-medium">
            Active
          </span>
        }
      />
      {args && (
        <pre className="bg-muted mt-2 max-h-32 overflow-auto rounded-md p-2 font-mono text-xs leading-5 whitespace-pre-wrap break-all">
          <code>{args}</code>
        </pre>
      )}
    </CatalogCard>
  );
}

function ToolResultCard({ event }: { event: ToolCallResultEvent }) {
  const [expanded, setExpanded] = useState(false);
  const status = toolStatusFromResult(event);
  const cardTone: CatalogCardTone = status === "failure" ? "danger" : "default";
  const out = event.content ?? "";
  const lines = out ? out.split("\n") : [];
  const isShort = status === "success" && lines.length <= 2 && out.length <= 200;
  const showExpand = !!out && (status === "failure" || !isShort);

  return (
    <CatalogCard tone={cardTone}>
      <CatalogHeader
        title="Result"
        tone={status === "failure" ? "danger" : "success"}
        status={
          <span
            className={`shrink-0 rounded-md border px-2 py-0.5 text-xs font-medium ${
              status === "success"
                ? "bg-success-subtle text-success border-success/30"
                : "bg-danger-subtle text-danger border-danger/30"
            }`}
          >
            {status === "success" ? "Success" : "Failed"}
          </span>
        }
      />
      {isShort && (
        <p className="text-muted-foreground mt-2 font-mono text-xs whitespace-pre-wrap">{out}</p>
      )}
      {showExpand && (
        <>
          <Button
            className="mt-2 w-full justify-between"
            size="sm"
            variant="ghost"
            onClick={() => setExpanded((v) => !v)}
          >
            <span>{expanded ? "Hide output" : `View output (${lines.length} lines)`}</span>
            <ChevronRight
              className={`size-4 transition-transform ${expanded ? "rotate-90" : ""}`}
            />
          </Button>
          {expanded && (
            <pre className="bg-muted mt-2 max-h-60 overflow-auto rounded-md p-2 font-mono text-xs leading-5 whitespace-pre-wrap">
              {out}
            </pre>
          )}
        </>
      )}
    </CatalogCard>
  );
}
