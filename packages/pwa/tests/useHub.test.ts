import { expect, test } from "bun:test";
import type { EventFrameForPwa } from "@cc-remote/proto";
import { appendEventToBuffer } from "../src/hooks/useHub";

function ev(jsonl_offset: number, payload: unknown = { type: "user" }): EventFrameForPwa {
  return {
    type: "event",
    daemon_id: "d",
    session_id: "s",
    jsonl_offset,
    ts: 1_700_000_000_000 + jsonl_offset,
    payload,
  };
}

test("appendEventToBuffer adds a new frame", () => {
  const out = appendEventToBuffer([], ev(10));
  expect(out.map((e) => e.jsonl_offset)).toEqual([10]);
});

test("appendEventToBuffer dedupes by jsonl_offset and returns the same array reference", () => {
  // Why same reference: useHub's reducer uses identity equality to skip the
  // React rerender on dedup hits. If this changes, downstream rerender
  // behavior breaks.
  const start = [ev(10), ev(20)];
  const out = appendEventToBuffer(start, ev(10));
  expect(out).toBe(start);
  expect(out.map((e) => e.jsonl_offset)).toEqual([10, 20]);
});

test("appendEventToBuffer dedupes the late-arriving event from the daemon's bind drain", () => {
  // The race the daemon fix addresses: a user-injected line arrives via the
  // initial drain (offset 100) AND, on reconnect, also via the live tail.
  // PWA must not show two user bubbles for the same JSONL line.
  const initial: EventFrameForPwa[] = [];
  const afterDrain = appendEventToBuffer(initial, ev(100, { type: "user", message: { content: "hi" } }));
  const afterLive = appendEventToBuffer(afterDrain, ev(100, { type: "user", message: { content: "hi" } }));
  expect(afterLive.length).toBe(1);
});

test("appendEventToBuffer trims to max length, keeping the newest frames", () => {
  const start = [ev(1), ev(2), ev(3)];
  const out = appendEventToBuffer(start, ev(4), 3);
  expect(out.map((e) => e.jsonl_offset)).toEqual([2, 3, 4]);
});

test("appendEventToBuffer doesn't trim when under max", () => {
  const start = [ev(1)];
  const out = appendEventToBuffer(start, ev(2), 5);
  expect(out.map((e) => e.jsonl_offset)).toEqual([1, 2]);
});
