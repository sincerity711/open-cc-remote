import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionTimeline } from "../src/screens/timeline/SessionTimeline";
import type { RenderItem } from "../src/screens/timeline/types";

test("SessionTimeline shows 'Loading history...' on empty + history pending", () => {
  const markup = renderToStaticMarkup(
    <SessionTimeline
      items={[]}
      hasMoreEarlier={true}
      historyLoading={true}
      onLoadEarlier={() => {}}
    />,
  );
  expect(markup).toContain("Loading history");
  expect(markup).not.toContain("Send a message to start");
});

test("SessionTimeline shows 'Loading earlier events...' button label while loading", () => {
  const dummyItem = {
    tag: "agui",
    id: "x",
    ts: 0,
    event: { type: "RAW", event: {} },
  } as unknown as RenderItem;
  const markup = renderToStaticMarkup(
    <SessionTimeline
      items={[dummyItem]}
      hasMoreEarlier={true}
      historyLoading={true}
      onLoadEarlier={() => {}}
    />,
  );
  expect(markup).toContain("Loading earlier events");
});

test("SessionTimeline shows timeout copy when historyTimedOut", () => {
  const markup = renderToStaticMarkup(
    <SessionTimeline
      items={[]}
      hasMoreEarlier={true}
      historyTimedOut={true}
      onLoadEarlier={() => {}}
    />,
  );
  expect(markup).toContain("History load not confirmed");
});

test("SessionTimeline shows 'Send a message to start.' when not loading", () => {
  const markup = renderToStaticMarkup(
    <SessionTimeline
      items={[]}
      hasMoreEarlier={true}
      historyLoading={false}
      onLoadEarlier={() => {}}
    />,
  );
  expect(markup).toContain("Send a message to start");
});
