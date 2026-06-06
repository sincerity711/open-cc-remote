import { Brain, ChevronRight, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReasoningMessageChunkEvent } from "@cc-remote/proto";
import type { ReasoningStatus } from "../../lib/reasoning-status";
import { CatalogCard } from "./cards/CatalogCard";
import { cn } from "../../lib/utils";

export interface ReasoningCardProps {
  event: ReasoningMessageChunkEvent;
  /** Wall-clock ms — the item's `ts` from RenderItem. Currently informational. */
  ts: number;
  status: ReasoningStatus;
  /** Wall-clock ms when this reasoning item first appeared in the timeline. */
  startedAt: number;
}

/**
 * Collapsible reasoning ("thinking") card.
 *
 *   - active → spinner + 1Hz elapsed timer + body expanded
 *   - done   → brain icon + frozen elapsed + body collapsed
 *
 * The active→done transition is driven by `computeReasoningStatus` outside
 * the component (no daemon "reasoning end" frame is needed). Click the
 * header to toggle expanded in either state — the auto-collapse-on-done
 * effect runs only on the status change, not on every render, so manual
 * expands after the transition stick.
 */
export function ReasoningCard({ event, status, startedAt }: ReasoningCardProps) {
  const [expanded, setExpanded] = useState(status === "active");
  const [elapsedMs, setElapsedMs] = useState(() =>
    Math.max(0, Date.now() - startedAt),
  );
  const startedAtRef = useRef(startedAt);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // Auto-collapse on active→done. `status` is the only dep, so manual
  // toggles after this fires aren't clobbered.
  useEffect(() => {
    if (status === "done") setExpanded(false);
  }, [status]);

  // 1Hz elapsed tick while active. Cleared on cleanup AND on transition
  // to done (status change re-runs the effect, which then short-circuits
  // before scheduling a new interval).
  useEffect(() => {
    startedAtRef.current = startedAt;
    setElapsedMs(Math.max(0, Date.now() - startedAt));
    if (status !== "active") return;
    const id = setInterval(() => {
      setElapsedMs(Math.max(0, Date.now() - startedAtRef.current));
    }, 1000);
    return () => clearInterval(id);
  }, [status, startedAt]);

  // Auto-scroll the body during streaming. Currently a no-op (daemon only
  // emits a single ReasoningMessageChunk per messageId today) but
  // future-proofs against forwarding Anthropic's streamed reasoning deltas.
  useEffect(() => {
    if (status === "active" && expanded && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [event.delta, status, expanded]);

  const summary =
    status === "active"
      ? `Thinking · ${formatDuration(elapsedMs)}`
      : `Thought · ${formatDuration(elapsedMs)}`;

  return (
    <CatalogCard>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="-m-1 flex w-full items-center justify-between gap-2 rounded-md p-1 text-left"
        aria-expanded={expanded}
        data-testid="reasoning-card-header"
      >
        <span className="flex min-w-0 items-center gap-2 font-semibold">
          <span className="border-border bg-muted inline-flex size-6 shrink-0 items-center justify-center rounded-md border">
            {status === "active" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Brain className="size-3.5" />
            )}
          </span>
          <span className="truncate">{summary}</span>
        </span>
        <ChevronRight
          className={cn(
            "size-4 shrink-0 transition-transform",
            expanded && "rotate-90",
          )}
        />
      </button>
      {expanded && (
        <div
          ref={bodyRef}
          className="bg-muted text-muted-foreground border-l-2 border-l-border/80 mt-2 max-h-60 overflow-auto rounded-md p-2.5"
          data-testid="reasoning-card-body"
        >
          <pre className="whitespace-pre-wrap text-sm leading-5">
            {event.delta && event.delta.length > 0
              ? event.delta
              : "(no reasoning text)"}
          </pre>
        </div>
      )}
    </CatalogCard>
  );
}

/**
 * `<60s → "Ns"`, `<3600s → "Nm Ss"`, else `"Hh Mm Ss"`. English only — no i18n.
 * Mirrors AionUi MessageThinking semantics with seconds clamped to 0.
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  if (totalSeconds < 3600) {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}m ${s}s`;
  }
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${h}h ${m}m ${s}s`;
}
