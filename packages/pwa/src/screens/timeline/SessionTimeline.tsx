import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { renderTimelineItem } from "./renderTimelineItem";
import type { RenderItem } from "./types";

export interface SessionTimelineProps {
  items: RenderItem[];
  idle?: boolean;
  hasMoreEarlier?: boolean;
  historyLoading?: boolean;
  historyTimedOut?: boolean;
  onLoadEarlier: () => void;
  /** Highest jsonl_offset among buffered events (-1 if none). Used to advance
   *  the lastSeen anchor when the user is at the bottom of the timeline. */
  maxOffset?: number;
  /** Count of buffered events newer than the lastSeen anchor — drives the
   *  "New events N" pill. Independent of items.length so mergeTimeline jitter
   *  (pending permission entering/leaving) and load-earlier history insertion
   *  don't pollute the count. */
  unreadCount?: number;
  onMarkSeen?: (offset: number) => void;
}

export function SessionTimeline({
  items,
  hasMoreEarlier = true,
  historyLoading = false,
  historyTimedOut = false,
  onLoadEarlier,
  maxOffset = -1,
  unreadCount = 0,
  onMarkSeen,
}: SessionTimelineProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    if (!autoScroll || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [items, autoScroll]);

  // While the user is at the bottom, continuously advance the lastSeen anchor
  // to the buffer's max offset. markSeen is monotonic in useLastSeen so a
  // smaller maxOffset (e.g. session switch) won't regress the counter.
  useEffect(() => {
    if (!autoScroll) return;
    if (maxOffset < 0) return;
    onMarkSeen?.(maxOffset);
  }, [autoScroll, maxOffset, onMarkSeen]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    setAutoScroll(atBottom);
    if (hasMoreEarlier && el.scrollTop < 80 && items.length > 0) {
      onLoadEarlier();
    }
  };

  const showJumpPill = !autoScroll && unreadCount > 0;

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      data-testid="timeline"
      className="bg-background relative flex-1 overflow-y-auto"
    >
      <div className="relative px-4 py-4 pl-12">
        <div className="bg-border absolute top-2 bottom-2 left-7 w-px" />
        {hasMoreEarlier && items.length > 0 && (
          <div className="mb-3 flex justify-center">
            <Button
              onClick={onLoadEarlier}
              size="sm"
              variant="ghost"
              disabled={historyLoading}
            >
              {historyLoading ? "Loading earlier events…" : "Load earlier events"}
            </Button>
          </div>
        )}
        {historyTimedOut && (
          <div
            className="text-danger mb-3 text-center text-xs"
            role="alert"
            data-testid="history-timeout"
          >
            History load not confirmed.
          </div>
        )}
        {items.map((it) => renderTimelineItem(it))}
        {items.length === 0 && (
          <p className="text-muted-foreground py-12 text-center text-sm">
            {historyLoading ? "Loading history…" : "Send a message to start."}
          </p>
        )}
      </div>
      {showJumpPill && (
        <button
          className="bg-primary text-primary-foreground shadow-card sticky bottom-3 ml-auto mr-3 inline-flex h-9 items-center gap-1 rounded-full px-3 text-xs font-semibold"
          data-testid="timeline-jump-new"
          onClick={() => {
            const el = scrollRef.current;
            if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
            setAutoScroll(true);
            // The autoScroll effect will fire markSeen(maxOffset) on the next render.
          }}
          type="button"
        >
          New events {unreadCount} ↓
        </button>
      )}
    </div>
  );
}
