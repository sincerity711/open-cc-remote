import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { renderTimelineItem, type RenderTimelineItemContext } from "./renderTimelineItem";
import type { TimelineEvent } from "./types";

export interface SessionTimelineProps {
  items: TimelineEvent[];
  onLoadEarlier: () => void;
  onOpenPermission?: (request_id: string) => void;
}

export function SessionTimeline({ items, onLoadEarlier, onOpenPermission }: SessionTimelineProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const lastLoadAt = useRef(0);

  useEffect(() => {
    if (!autoScroll || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [items, autoScroll]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    setAutoScroll(atBottom);
    const now = Date.now();
    if (el.scrollTop < 80 && items.length > 0 && now - lastLoadAt.current > 500) {
      lastLoadAt.current = now;
      onLoadEarlier();
    }
  };

  const ctx: RenderTimelineItemContext = { onOpenPermission };

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      data-testid="timeline"
      className="bg-background flex-1 overflow-y-auto"
    >
      {items.length === 0 ? (
        <div className="flex h-full items-center justify-center p-6">
          <p className="text-muted-foreground text-sm">Send a message to start.</p>
        </div>
      ) : (
        <div className="relative px-4 py-4 pl-12">
          <div className="bg-border absolute top-2 bottom-2 left-7 w-px" />
          <div className="mb-3 flex justify-center">
            <Button onClick={onLoadEarlier} size="sm" variant="ghost">
              Load earlier events
            </Button>
          </div>
          {items.map((it) => renderTimelineItem(it, ctx))}
        </div>
      )}
    </div>
  );
}
