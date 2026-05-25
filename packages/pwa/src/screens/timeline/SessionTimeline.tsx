import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { renderTimelineItem, type RenderTimelineItemContext } from "./renderTimelineItem";
import type { RenderItem } from "./types";

export interface SessionTimelineProps {
  items: RenderItem[];
  idle?: boolean;
  hasMoreEarlier?: boolean;
  onLoadEarlier: () => void;
  onOpenPermission?: (request_id: string) => void;
}

export function SessionTimeline({ items, hasMoreEarlier = true, onLoadEarlier, onOpenPermission }: SessionTimelineProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const lastLoadAt = useRef(0);
  // Number of items the user has "seen" — i.e. the items.length value at the
  // last time the timeline was either auto-scrolling at bottom or the user
  // explicitly clicked the "New events" pill. While the user is scrolled up,
  // any items beyond this count are unseen and trigger the pill.
  const lastSeenLength = useRef(items.length);

  useEffect(() => {
    if (!autoScroll || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [items, autoScroll]);

  // Reset the unseen counter while the user is at the bottom.
  useEffect(() => {
    if (autoScroll) lastSeenLength.current = items.length;
  }, [items, autoScroll]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    setAutoScroll(atBottom);
    const now = Date.now();
    if (
      hasMoreEarlier &&
      el.scrollTop < 80 &&
      items.length > 0 &&
      now - lastLoadAt.current > 500
    ) {
      lastLoadAt.current = now;
      onLoadEarlier();
    }
  };

  const ctx: RenderTimelineItemContext = { onOpenPermission };
  const showJumpPill = !autoScroll && items.length > lastSeenLength.current;

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
            <Button onClick={onLoadEarlier} size="sm" variant="ghost">
              Load earlier events
            </Button>
          </div>
        )}
        {items.map((it) => renderTimelineItem(it, ctx))}
        {items.length === 0 && (
          <p className="text-muted-foreground py-12 text-center text-sm">Send a message to start.</p>
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
            lastSeenLength.current = items.length;
          }}
          type="button"
        >
          New events {items.length - lastSeenLength.current} ↓
        </button>
      )}
    </div>
  );
}
