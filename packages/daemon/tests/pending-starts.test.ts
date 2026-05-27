import { test, expect } from "bun:test";
import { createPendingStarts } from "../src/pending-starts";

test("matches a registered session by cwd FIFO", () => {
  const t = createPendingStarts({ ttlMs: 60_000, now: () => 0 });
  t.add("req-1", "/a");
  t.add("req-2", "/b");
  expect(t.consume("/a")).toBe("req-1");
  expect(t.consume("/a")).toBeUndefined();
  expect(t.consume("/b")).toBe("req-2");
});

test("FIFO across same-cwd entries", () => {
  const t = createPendingStarts({ ttlMs: 60_000, now: () => 0 });
  t.add("req-1", "/a");
  t.add("req-2", "/a");
  expect(t.consume("/a")).toBe("req-1");
  expect(t.consume("/a")).toBe("req-2");
});

test("ignores entries with no request_id", () => {
  const t = createPendingStarts({ ttlMs: 60_000, now: () => 0 });
  t.add(undefined, "/a");
  expect(t.consume("/a")).toBeUndefined();
});

test("expires entries past ttl", () => {
  let now = 0;
  const t = createPendingStarts({ ttlMs: 1_000, now: () => now });
  t.add("req-1", "/a");
  now = 2_000;
  expect(t.consume("/a")).toBeUndefined();
});

test("consume returns undefined for unmatched cwd", () => {
  const t = createPendingStarts({ ttlMs: 60_000, now: () => 0 });
  t.add("req-1", "/a");
  expect(t.consume("/other")).toBeUndefined();
});
