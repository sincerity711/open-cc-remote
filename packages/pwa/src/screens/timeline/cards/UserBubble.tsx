import { CatalogCard } from "./CatalogCard";
import { CatalogHeader } from "./CatalogHeader";

/**
 * Static demo bubble (kept for /demo & catalog preview). Real timeline uses
 * `UserBubbleLive` below.
 */
export function UserBubble() {
  return (
    <UserBubbleLive
      body="Please add password reset flow using email tokens."
      time="10:24 AM"
    />
  );
}

export function UserBubbleSurface() {
  return <UserBubble />;
}

/**
 * Live user message. Per docs/design/light-timeline.png the user message sits
 * on the rail like every other event (rail glyph = `user`); the only thing
 * distinguishing it from a Claude bubble is card tone (purple/primary-subtle).
 */
export function UserBubbleLive({
  body,
  time,
}: {
  body: string;
  time: string;
}) {
  return (
    <CatalogCard tone="purple">
      <CatalogHeader title="You" meta={time} />
      <p className="mt-2 leading-5 whitespace-pre-wrap">{body}</p>
    </CatalogCard>
  );
}
