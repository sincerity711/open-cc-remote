import { test, expect } from "bun:test";
import { SessionMap } from "../src/session-map.ts";
import type { Span, Context } from "@opentelemetry/api";

function fakeSpan(): { span: Span; ended: { value: boolean } } {
  const ended = { value: false };
  const span = {
    end: () => {
      ended.value = true;
    },
    spanContext: () => ({ traceId: "00000000000000000000000000000001", spanId: "0000000000000001", traceFlags: 1 }),
    setAttribute: () => span,
    setAttributes: () => span,
    addEvent: () => span,
    setStatus: () => span,
    updateName: () => span,
    isRecording: () => true,
    recordException: () => {},
    addLink: () => span,
    addLinks: () => span,
  } as unknown as Span;
  return { span, ended };
}

const fakeCtx = {} as Context;

test("session-map: push/peek/pop stack semantics", () => {
  const map = new SessionMap({ sweepIntervalMs: 0 });
  const a = fakeSpan();
  const b = fakeSpan();
  map.push("s1", { rootCtx: fakeCtx, rootSpan: a.span });
  map.push("s1", { rootCtx: fakeCtx, rootSpan: b.span });
  expect(map.size()).toBe(2);
  expect(map.peek("s1")?.rootSpan).toBe(b.span);
  expect(map.pop("s1")?.rootSpan).toBe(b.span);
  expect(map.pop("s1")?.rootSpan).toBe(a.span);
  expect(map.has("s1")).toBe(false);
  map.dispose();
});

test("session-map: peek bumps lastActivityMs", () => {
  let now = 1_000;
  const map = new SessionMap({ sweepIntervalMs: 0, now: () => now });
  map.push("s1", { rootCtx: fakeCtx, rootSpan: fakeSpan().span });
  now = 100_000;
  const peeked = map.peek("s1");
  expect(peeked).toBeDefined();
  expect(peeked!.lastActivityMs).toBe(100_000);
  map.dispose();
});

test("session-map: sweep evicts stale entries and ends their spans", () => {
  let now = 0;
  const map = new SessionMap({ sweepIntervalMs: 0, ttlMs: 1_000, now: () => now });
  const a = fakeSpan();
  const b = fakeSpan();
  map.push("s1", { rootCtx: fakeCtx, rootSpan: a.span });
  now = 5_000; // s1's last activity is at t=0, ttl=1000, so it's stale at t=5000.
  map.push("s2", { rootCtx: fakeCtx, rootSpan: b.span });
  const evicted = map.sweep();
  expect(evicted).toBe(1);
  expect(a.ended.value).toBe(true);
  expect(b.ended.value).toBe(false);
  expect(map.has("s1")).toBe(false);
  expect(map.has("s2")).toBe(true);
  map.dispose();
});

test("session-map: dispose ends remaining spans", () => {
  const map = new SessionMap({ sweepIntervalMs: 0 });
  const a = fakeSpan();
  map.push("s1", { rootCtx: fakeCtx, rootSpan: a.span });
  map.dispose();
  expect(a.ended.value).toBe(true);
  expect(map.has("s1")).toBe(false);
});

test("session-map: pop on empty returns undefined", () => {
  const map = new SessionMap({ sweepIntervalMs: 0 });
  expect(map.pop("nope")).toBeUndefined();
  expect(map.peek("nope")).toBeUndefined();
  map.dispose();
});
