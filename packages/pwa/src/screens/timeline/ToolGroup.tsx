import {
  AlertCircle,
  ChevronRight,
  CheckCircle2,
  type LucideIcon,
  Pencil,
  Terminal,
  FileText,
  Wrench,
} from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "../../lib/utils";
import { toolStatusFromResult, type ToolStatus } from "../../lib/view-helpers";
import type {
  ToolCallChunkEvent,
  ToolCallResultEvent,
} from "@cc-remote/proto";
import { CatalogCard, type CatalogCardTone } from "./cards/CatalogCard";
import { CatalogHeader } from "./cards/CatalogHeader";

/**
 * Collapsible group of tool events.
 *
 * Default state: collapsed — even a single tool. A one-liner header tells
 * the user *what* happened (running / ran N · duration · any failures);
 * the card bodies are an opt-in expand. This is the chat-first regime —
 * tool calls are noise relative to "what is Claude saying", so they hide
 * by default.
 *
 * Active tools: header reads "Running <Tool>…" with a breathing dot. The
 * header itself is the live signal so the user doesn't have to expand
 * just to know the assistant is working.
 *
 * Expanded state is persisted in sessionStorage per group id so navigating
 * away and back doesn't fold the group again on the user.
 */
export interface ToolGroupItem {
  id: string;
  chunk: ToolCallChunkEvent;
  result?: ToolCallResultEvent;
}

const STORAGE_PREFIX = "cc_remote_tool_group_";

function loadExpanded(id: string): boolean {
  if (typeof window === "undefined") return false;
  return window.sessionStorage.getItem(STORAGE_PREFIX + id) === "1";
}
function saveExpanded(id: string, expanded: boolean) {
  if (typeof window === "undefined") return;
  if (expanded) window.sessionStorage.setItem(STORAGE_PREFIX + id, "1");
  else window.sessionStorage.removeItem(STORAGE_PREFIX + id);
}

export function ToolGroup({
  id,
  items,
}: {
  id: string;
  items: ToolGroupItem[];
}) {
  const [expanded, setExpanded] = useState(() => loadExpanded(id));
  useEffect(() => saveExpanded(id, expanded), [id, expanded]);

  const summary = summarize(items);
  const HeaderIcon = summary.headerIcon;

  return (
    <section
      className={cn(
        "border-border bg-surface shadow-card rounded-card overflow-hidden border cc-transition-state",
        // Subtle accent when something is currently running so the eye
        // catches it without the whole card screaming.
        summary.kind === "running" && "border-primary/30",
        // Failed tools surface as a soft danger tint on the header so the
        // user notices even when the group is collapsed.
        summary.kind === "failed" && "border-danger/30",
      )}
      data-testid="tool-group"
      data-group-id={id}
      data-expanded={expanded}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          "flex w-full items-center gap-2.5 px-3 text-left cc-transition-state",
          "hover:bg-muted/60",
          // Header height stays constant whether collapsed or expanded so
          // the layout doesn't jitter when the user toggles.
          "h-11",
        )}
        aria-expanded={expanded}
      >
        <span
          className={cn(
            "inline-flex size-6 shrink-0 items-center justify-center rounded-md",
            summary.kind === "running" && "bg-primary-subtle text-primary",
            summary.kind === "failed" && "bg-danger-subtle text-danger",
            summary.kind === "ok" && "bg-muted text-muted-foreground",
          )}
        >
          {summary.kind === "running" ? (
            <span className="cc-pulse-working size-1.5 rounded-full bg-current" />
          ) : (
            <HeaderIcon className="size-3.5" />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
          {summary.label}
          {summary.detail && (
            <span className="text-tertiary-foreground ml-2 font-normal">
              {summary.detail}
            </span>
          )}
        </span>
        {summary.failedCount > 0 && (
          <span className="bg-danger-subtle text-danger inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-semibold">
            {summary.failedCount} failed
          </span>
        )}
        <ChevronRight
          className={cn(
            "text-muted-foreground size-4 shrink-0 cc-transition-state",
            expanded && "rotate-90",
          )}
        />
      </button>
      {expanded && (
        <div className="border-border bg-muted/40 border-t px-3 py-3">
          <div className="flex flex-col gap-2">
            {items.map((it) => (
              <ToolRow key={it.id} item={it} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * Per-tool card inside an expanded group. Slimmer than the standalone
 * tool card we used to render — no outer shadow, no large margins. The
 * group container already provides the visual chrome.
 */
function ToolRow({ item }: { item: ToolGroupItem }) {
  const name = item.chunk.toolCallName ?? "tool";
  const icon = pickStrongToolIcon(name) ?? Wrench;
  const args = item.chunk.delta ?? "";
  const status: ToolStatus | "active" = item.result
    ? toolStatusFromResult(item.result)
    : "active";
  const tone: CatalogCardTone =
    status === "failure"
      ? "danger"
      : status === "active"
        ? "active"
        : "default";
  const out = item.result?.content ?? "";
  const lines = out ? out.split("\n") : [];
  const isShort = status === "success" && lines.length <= 2 && out.length <= 200;
  const showOutputBlock = !!out && (status === "failure" || !isShort);
  const [outputOpen, setOutputOpen] = useState(false);

  return (
    <CatalogCard tone={tone}>
      <CatalogHeader
        icon={icon}
        title={name}
        tone={
          status === "failure"
            ? "danger"
            : status === "success"
              ? "success"
              : undefined
        }
        status={
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium",
              status === "success" &&
                "bg-success-subtle text-success border-success/30",
              status === "failure" &&
                "bg-danger-subtle text-danger border-danger/30",
              status === "active" &&
                "bg-primary-subtle text-primary border-primary/30",
            )}
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
        <pre className="bg-muted text-muted-foreground border-l-2 border-l-border/80 mt-2 max-h-32 overflow-auto rounded-md p-2.5 font-mono text-[13px] leading-[1.55] whitespace-pre-wrap break-all">
          <code>{args}</code>
        </pre>
      )}
      {item.result && isShort && (
        <p className="text-muted-foreground mt-2 font-mono text-[13px] leading-[1.55] whitespace-pre-wrap">
          {out}
        </p>
      )}
      {showOutputBlock && (
        <>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground hover:bg-muted -mx-1 mt-2 inline-flex h-8 w-full items-center justify-between rounded-md px-3 text-xs font-medium cc-transition-state"
            onClick={() => setOutputOpen((v) => !v)}
          >
            <span>
              {outputOpen
                ? "Hide output"
                : `View output (${lines.length} lines)`}
            </span>
            <ChevronRight
              className={cn(
                "size-4 cc-transition-state",
                outputOpen && "rotate-90",
              )}
            />
          </button>
          {outputOpen && (
            <pre className="bg-muted text-muted-foreground border-l-2 border-l-border/80 mt-2 max-h-60 overflow-auto rounded-md p-2.5 font-mono text-[13px] leading-[1.55] whitespace-pre-wrap">
              {out}
            </pre>
          )}
        </>
      )}
    </CatalogCard>
  );
}

interface Summary {
  kind: "running" | "ok" | "failed";
  label: string;
  detail?: string;
  failedCount: number;
  headerIcon: LucideIcon;
}

function summarize(items: ToolGroupItem[]): Summary {
  const running = items.filter((it) => !it.result);
  const failed = items.filter(
    (it) => it.result && toolStatusFromResult(it.result) === "failure",
  );
  const failedCount = failed.length;

  if (running.length > 0) {
    const active = running[running.length - 1]!;
    const name = active.chunk.toolCallName ?? "command";
    const args = (active.chunk.delta ?? "").split("\n")[0]?.trim() ?? "";
    return {
      kind: "running",
      label: items.length === 1 ? `Running ${name}…` : `Running ${name}…`,
      detail: args ? args.slice(0, 80) : undefined,
      failedCount,
      headerIcon: pickStrongToolIcon(name) ?? Wrench,
    };
  }

  // All resolved — singleton vs run.
  if (items.length === 1) {
    const it = items[0]!;
    const name = it.chunk.toolCallName ?? "tool";
    const args = (it.chunk.delta ?? "").split("\n")[0]?.trim() ?? "";
    return {
      kind: failedCount > 0 ? "failed" : "ok",
      label: name,
      detail: args ? args.slice(0, 80) : undefined,
      failedCount,
      headerIcon: failedCount > 0 ? AlertCircle : CheckCircle2,
    };
  }

  // Multiple resolved tools.
  const duration = computeDuration(items);
  return {
    kind: failedCount > 0 ? "failed" : "ok",
    label: `Ran ${items.length} commands`,
    detail: duration,
    failedCount,
    headerIcon: failedCount > 0 ? AlertCircle : CheckCircle2,
  };
}

function computeDuration(items: ToolGroupItem[]): string | undefined {
  const ts = items
    .flatMap((it) => [
      it.chunk.timestamp ?? 0,
      it.result?.timestamp ?? 0,
    ])
    .filter((n) => n > 0);
  if (ts.length < 2) return undefined;
  const span = Math.max(...ts) - Math.min(...ts);
  if (span < 1000) return undefined;
  if (span < 60_000) return `${Math.round(span / 1000)}s`;
  return `${Math.round(span / 60_000)}m`;
}

function pickStrongToolIcon(name: string): LucideIcon | undefined {
  if (!name) return undefined;
  if (name === "Bash") return Terminal;
  if (name === "Edit" || name === "Write" || name === "MultiEdit") return Pencil;
  if (name === "Read") return FileText;
  return undefined;
}
