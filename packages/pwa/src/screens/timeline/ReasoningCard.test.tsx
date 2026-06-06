import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EventType, type ReasoningMessageChunkEvent } from "@cc-remote/proto";
import { ReasoningCard, formatDuration } from "./ReasoningCard";

function makeEvent(delta = "let me think about this"): ReasoningMessageChunkEvent {
  return {
    type: EventType.REASONING_MESSAGE_CHUNK,
    messageId: "m1",
    delta,
  } as unknown as ReasoningMessageChunkEvent;
}

function visibleText(markup: string): string {
  return markup.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

test("ReasoningCard active branch renders spinner and 'Thinking' summary, body visible", () => {
  const startedAt = Date.now() - 5000; // 5 seconds elapsed
  const markup = renderToStaticMarkup(
    <ReasoningCard
      event={makeEvent("first thoughts streaming in")}
      ts={startedAt}
      status="active"
      startedAt={startedAt}
    />,
  );
  // Active state uses Loader2 + animate-spin.
  expect(markup).toContain("animate-spin");
  // Body is rendered when expanded (default for active).
  expect(markup).toContain('data-testid="reasoning-card-body"');
  const text = visibleText(markup);
  expect(text).toContain("Thinking");
  expect(text).toContain("first thoughts streaming in");
});

test("ReasoningCard done branch renders brain icon, 'Thought' summary, body collapsed", () => {
  const startedAt = Date.now() - 5000;
  const markup = renderToStaticMarkup(
    <ReasoningCard
      event={makeEvent("final reasoning text")}
      ts={startedAt}
      status="done"
      startedAt={startedAt}
    />,
  );
  // Done state has no spinner.
  expect(markup).not.toContain("animate-spin");
  // Done collapses the body — initial state is `status === "active"`, which is false here.
  expect(markup).not.toContain('data-testid="reasoning-card-body"');
  const text = visibleText(markup);
  expect(text).toContain("Thought");
  // 5s elapsed at first paint.
  expect(text).toContain("5s");
});

test("ReasoningCard done branch renders 'Nm Ss' for elapsed >= 60s", () => {
  const startedAt = Date.now() - 83_000; // 1m 23s
  const markup = renderToStaticMarkup(
    <ReasoningCard
      event={makeEvent("done reasoning")}
      ts={startedAt}
      status="done"
      startedAt={startedAt}
    />,
  );
  expect(visibleText(markup)).toContain("1m 23s");
});

test("ReasoningCard renders fallback copy when delta is empty", () => {
  const startedAt = Date.now();
  const markup = renderToStaticMarkup(
    <ReasoningCard
      event={makeEvent("")}
      ts={startedAt}
      status="active"
      startedAt={startedAt}
    />,
  );
  expect(visibleText(markup)).toContain("(no reasoning text)");
});

test("ReasoningCard header is a clickable button with aria-expanded", () => {
  const startedAt = Date.now();
  const markup = renderToStaticMarkup(
    <ReasoningCard
      event={makeEvent("x")}
      ts={startedAt}
      status="active"
      startedAt={startedAt}
    />,
  );
  expect(markup).toMatch(/<button[^>]*aria-expanded="true"/);
  expect(markup).toContain('data-testid="reasoning-card-header"');
});

// formatDuration unit coverage — round-trip the bands the component reads.
test("formatDuration: <1s → '0s'", () => {
  expect(formatDuration(0)).toBe("0s");
  expect(formatDuration(500)).toBe("0s");
});

test("formatDuration: <60s → 'Ns'", () => {
  expect(formatDuration(12_000)).toBe("12s");
  expect(formatDuration(59_999)).toBe("59s");
});

test("formatDuration: <3600s → 'Nm Ss'", () => {
  expect(formatDuration(60_000)).toBe("1m 0s");
  expect(formatDuration(83_000)).toBe("1m 23s");
  expect(formatDuration(3_599_000)).toBe("59m 59s");
});

test("formatDuration: >=3600s → 'Hh Mm Ss'", () => {
  expect(formatDuration(3_600_000)).toBe("1h 0m 0s");
  expect(formatDuration(3_661_000)).toBe("1h 1m 1s");
  expect(formatDuration(7_322_000)).toBe("2h 2m 2s");
});

test("formatDuration: clamps negative ms to 0s", () => {
  expect(formatDuration(-50)).toBe("0s");
});
