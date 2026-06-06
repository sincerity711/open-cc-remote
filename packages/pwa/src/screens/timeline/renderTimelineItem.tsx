import {
  ChevronRight,
  type LucideIcon,
  Pencil,
  Terminal,
  FileText,
} from "lucide-react";
import { useState } from "react";
import type React from "react";
import {
  EventType,
  type AGUIEvent,
  type PwaAskUserQuestionRequest,
  type PwaPermissionRequest,
  type ToolCallChunkEvent,
  type ToolCallResultEvent,
  type ReasoningMessageChunkEvent,
  type RawEvent,
  type TextMessageChunkEvent,
} from "@cc-remote/proto";
import { CatalogCard, type CatalogCardTone } from "./cards/CatalogCard";
import { CatalogHeader } from "./cards/CatalogHeader";
import { AssistantBubbleLive } from "./cards/AssistantBubble";
import { UserBubbleLive } from "./cards/UserBubble";
import { ResolvedAskQuestionCard } from "./ResolvedAskQuestionCard";
import { ResolvedPermissionCard } from "./ResolvedPermissionCard";
import { SessionTimelineItem, type TimelineMarker } from "./SessionTimelineItem";
import type { RenderItem } from "./types";
import { toolStatusFromResult, type ToolStatus } from "../../lib/view-helpers";

/**
 * Read-only lookup tables threaded from `useHub` down through `SessionView`,
 * `SessionTimeline`, and `renderTimelineGroup` so the renderer can resolve
 * a `*_resolved` frame back to its original request payload + (locally
 * captured) answers without reaching into hub state. Cross-device path
 * misses fall through to placeholder bodies in the resolved cards.
 */
export interface RenderTimelineCtx {
  permissionRequestHistory: Record<string, PwaPermissionRequest>;
  askQuestionRequestHistory: Record<string, PwaAskUserQuestionRequest>;
  askQuestionAnswerHistory: Record<string, (string | null)[]>;
}

const EMPTY_CTX: RenderTimelineCtx = {
  permissionRequestHistory: {},
  askQuestionRequestHistory: {},
  askQuestionAnswerHistory: {},
};

export function renderTimelineItem(
  item: RenderItem,
  ctx: RenderTimelineCtx = EMPTY_CTX,
): React.ReactElement {
  const marker = pickMarker(item);

  switch (item.tag) {
    case "permission-resolved": {
      const request = ctx.permissionRequestHistory[item.resolved.request_id] ?? null;
      return (
        <SessionTimelineItem key={item.id} marker={marker}>
          <ResolvedPermissionCard resolved={item.resolved} request={request} />
        </SessionTimelineItem>
      );
    }

    case "ask-question-resolved": {
      const request = ctx.askQuestionRequestHistory[item.resolved.request_id] ?? null;
      const answers = ctx.askQuestionAnswerHistory[item.resolved.request_id] ?? null;
      return (
        <SessionTimelineItem key={item.id} marker={marker}>
          <ResolvedAskQuestionCard
            resolved={item.resolved}
            request={request}
            answers={answers}
          />
        </SessionTimelineItem>
      );
    }

    case "tool":
      return (
        <SessionTimelineItem key={item.id} marker={marker}>
          <ToolCard chunk={item.chunk} result={item.result} />
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

    // TOOL_CALL_CHUNK and TOOL_CALL_RESULT are merged into a single
    // synthetic "tool" RenderItem upstream in mergeTimeline; the renderer
    // never sees them as standalone agui items.

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
  if (item.tag === "permission-resolved") {
    return item.resolved.decision === "deny" || item.resolved.decision === "expired"
      ? "error"
      : item.resolved.decision === "terminal"
        ? "error"
        : "success";
  }
  if (item.tag === "ask-question-resolved") {
    return item.resolved.resolution === "answered" ? "success" : "idle";
  }
  if (item.tag === "tool") {
    if (item.result && toolStatusFromResult(item.result) === "failure") return "error";
    return "tool";
  }
  switch (item.event.type) {
    case EventType.TEXT_MESSAGE_CHUNK:
      return (item.event as TextMessageChunkEvent).role === "user" ? "user" : "claude";
    case EventType.REASONING_MESSAGE_CHUNK:
      return "claude";
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

/**
 * Merged tool card: header + args (always from the chunk) + status badge +
 * output (when the matching TOOL_CALL_RESULT has arrived).
 *
 * Status flow: chunk-only -> "Active"; result.is_error -> "Failed";
 * otherwise -> "Success". The merge happens in mergeTimeline so that
 * later out-of-order delivery of the result still updates the same card
 * instead of producing a second one.
 */
function ToolCard({
  chunk,
  result,
}: {
  chunk: ToolCallChunkEvent;
  result?: ToolCallResultEvent;
}) {
  const [expanded, setExpanded] = useState(false);
  const name = chunk.toolCallName ?? "tool";
  const icon = pickStrongToolIcon(name);
  const args = chunk.delta ?? "";

  const status: ToolStatus | "active" = result ? toolStatusFromResult(result) : "active";
  const cardTone: CatalogCardTone =
    status === "failure" ? "danger" : status === "active" ? "active" : "default";

  const out = result?.content ?? "";
  const lines = out ? out.split("\n") : [];
  const isShort = status === "success" && lines.length <= 2 && out.length <= 200;
  const showExpand = !!out && (status === "failure" || !isShort);

  return (
    <CatalogCard tone={cardTone}>
      <CatalogHeader
        icon={icon}
        title={name}
        tone={status === "failure" ? "danger" : status === "success" ? "success" : undefined}
        status={
          <span
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium cc-transition-state ${
              status === "success"
                ? "bg-success-subtle text-success border-success/30"
                : status === "failure"
                  ? "bg-danger-subtle text-danger border-danger/30"
                  : "bg-primary-subtle text-primary border-primary/30"
            }`}
          >
            {status === "active" ? (
              <>
                <span className="cc-pulse-working size-1.5 rounded-full bg-current" />
                Running
              </>
            ) : status === "success" ? (
              "Success"
            ) : (
              "Failed"
            )}
          </span>
        }
      />
      {args && (
        <pre className="bg-muted text-muted-foreground border-border/60 mt-2 max-h-32 overflow-auto rounded-md border-l-2 border-l-border/80 p-2.5 font-mono text-[13px] leading-[1.55] whitespace-pre-wrap break-all">
          <code>{args}</code>
        </pre>
      )}
      {result && isShort && (
        <p className="text-muted-foreground mt-2 font-mono text-[13px] leading-[1.55] whitespace-pre-wrap">
          {out}
        </p>
      )}
      {result && showExpand && (
        <>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground hover:bg-muted mt-2 -mx-1 inline-flex h-8 w-full items-center justify-between rounded-md px-3 text-xs font-medium cc-transition-state"
            onClick={() => setExpanded((v) => !v)}
          >
            <span>
              {expanded ? "Hide output" : `View output (${lines.length} lines)`}
            </span>
            <ChevronRight
              className={`size-4 transition-transform ${expanded ? "rotate-90" : ""}`}
            />
          </button>
          {expanded && (
            <pre className="bg-muted text-muted-foreground border-l-2 border-l-border/80 mt-2 max-h-60 overflow-auto rounded-md p-2.5 font-mono text-[13px] leading-[1.55] whitespace-pre-wrap">
              {out}
            </pre>
          )}
        </>
      )}
    </CatalogCard>
  );
}
