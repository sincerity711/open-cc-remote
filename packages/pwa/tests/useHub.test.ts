import { expect, test } from "bun:test";
import type { EventFrameForPwa } from "@cc-remote/proto";
import { appendEventToBuffer, type BufferedEvent } from "../src/hooks/useHub";

function ev(jsonl_offset: number, payload: EventFrameForPwa["payload"] = []): EventFrameForPwa {
  return {
    type: "event",
    daemon_id: "d",
    session_id: "s",
    jsonl_offset,
    ts: 1_700_000_000_000 + jsonl_offset,
    payload,
  };
}

// Helper: build a BufferedEvent[] from an existing buffer for easier assertions.
function offsets(buf: BufferedEvent[]): number[] {
  // Return unique jsonl_offsets in order (each row may produce multiple entries).
  const seen = new Set<number>();
  const result: number[] = [];
  for (const e of buf) {
    if (!seen.has(e.jsonl_offset)) { seen.add(e.jsonl_offset); result.push(e.jsonl_offset); }
  }
  return result;
}

test("appendEventToBuffer adds a new frame (empty payload → 0 BufferedEvents, no offset)", () => {
  // An empty-payload frame still deduplicates but produces 0 BufferedEvents.
  const out = appendEventToBuffer([], ev(10, []));
  expect(out).toHaveLength(0);
});

test("appendEventToBuffer flattens payload[] into individual BufferedEvent records", () => {
  const agEvent = { type: "TEXT_MESSAGE_CHUNK" } as EventFrameForPwa["payload"][number];
  const frame = ev(10, [agEvent, agEvent]);
  const out = appendEventToBuffer([], frame);
  expect(out).toHaveLength(2);
  expect(out[0].jsonl_offset).toBe(10);
  expect(out[0].event_index).toBe(0);
  expect(out[1].event_index).toBe(1);
  expect(out[0].daemon_id).toBe("d");
  expect(out[0].session_id).toBe("s");
  expect(out[0].ts).toBe(1_700_000_000_010);
});

test("appendEventToBuffer dedupes by jsonl_offset and returns the same array reference", () => {
  // Why same reference: useHub's reducer uses identity equality to skip the
  // React rerender on dedup hits. If this changes, downstream rerender
  // behavior breaks.
  const agEvent = { type: "TEXT_MESSAGE_CHUNK" } as EventFrameForPwa["payload"][number];
  const start = appendEventToBuffer([], ev(10, [agEvent]));
  const start2 = appendEventToBuffer(start, ev(20, [agEvent]));
  // Dedup: frame with offset 10 already present — must return same reference.
  const out = appendEventToBuffer(start2, ev(10, [agEvent]));
  expect(out).toBe(start2);
  expect(offsets(out)).toEqual([10, 20]);
});

test("appendEventToBuffer dedupes the late-arriving event from the daemon's bind drain", () => {
  // The race the daemon fix addresses: a user-injected line arrives via the
  // initial drain (offset 100) AND, on reconnect, also via the live tail.
  // PWA must not show two user bubbles for the same JSONL line.
  const agEvent = { type: "TEXT_MESSAGE_CHUNK" } as EventFrameForPwa["payload"][number];
  const initial: BufferedEvent[] = [];
  const afterDrain = appendEventToBuffer(initial, ev(100, [agEvent]));
  const afterLive = appendEventToBuffer(afterDrain, ev(100, [agEvent]));
  expect(offsets(afterLive)).toEqual([100]);
});

test("appendEventToBuffer trims to max length, keeping the newest frames", () => {
  const agEvent = { type: "TEXT_MESSAGE_CHUNK" } as EventFrameForPwa["payload"][number];
  // Each frame has 1 event → 1 BufferedEvent per offset.
  let buf: BufferedEvent[] = [];
  buf = appendEventToBuffer(buf, ev(1, [agEvent]));
  buf = appendEventToBuffer(buf, ev(2, [agEvent]));
  buf = appendEventToBuffer(buf, ev(3, [agEvent]));
  // max=3 means after adding offset 4 the oldest (offset 1) is dropped.
  const out = appendEventToBuffer(buf, ev(4, [agEvent]), 3);
  expect(offsets(out)).toEqual([2, 3, 4]);
});

test("appendEventToBuffer doesn't trim when under max", () => {
  const agEvent = { type: "TEXT_MESSAGE_CHUNK" } as EventFrameForPwa["payload"][number];
  let buf: BufferedEvent[] = [];
  buf = appendEventToBuffer(buf, ev(1, [agEvent]));
  const out = appendEventToBuffer(buf, ev(2, [agEvent]), 5);
  expect(offsets(out)).toEqual([1, 2]);
});
