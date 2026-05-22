import { User } from "lucide-react";
import { CatalogCard } from "./CatalogCard";

/**
 * Static demo bubble (kept for /demo & catalog preview). Real timeline uses
 * `UserBubbleLive` below.
 */
export function UserBubble() {
  return (
    <CatalogCard>
      <UserBubbleSurface />
    </CatalogCard>
  );
}

export function UserBubbleSurface() {
  return (
    <UserBubbleLive
      body="Please add password reset flow using email tokens."
      time="10:24 AM"
    />
  );
}

/**
 * Live user message. Per docs/design/light-timeline.png this floats outside
 * the timeline rail (chat layout, right-aligned, leading avatar) — distinct
 * from claude / tool / system events which sit on the rail.
 */
export function UserBubbleLive({
  body,
  time,
}: {
  body: string;
  time: string;
}) {
  return (
    <div className="flex items-start gap-2 pl-8">
      <div className="flex min-w-0 flex-1 flex-col items-end">
        <div className="text-muted-foreground mb-1 flex items-center gap-1.5 text-xs">
          <span className="font-semibold text-foreground">You</span>
          {time && <span>{time}</span>}
        </div>
        <div className="bg-primary-subtle border-primary/20 max-w-[88%] rounded-2xl rounded-tr-sm border px-3 py-2 text-sm">
          <p className="whitespace-pre-wrap">{body}</p>
        </div>
      </div>
      <span className="bg-primary-subtle border-primary/30 flex size-7 shrink-0 items-center justify-center rounded-full border">
        <User className="text-primary size-3.5" />
      </span>
    </div>
  );
}
