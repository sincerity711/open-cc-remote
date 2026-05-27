import { test, expect, beforeAll } from "bun:test";
import { trace } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import {
  beginRoundTrip,
  withSessionChildSpan,
  endRoundTrip,
  getSessionMap,
  disposeSessionMap,
} from "../src/otel.ts";
import { injectFrame } from "@cc-remote/observability";

// Use a fresh provider+exporter, but tolerate the case where another test
// (observability/propagator.test.ts when run in the same `bun test` invocation)
// has already set the global provider. We attach our own SpanProcessor either
// way so we can read finished spans.
const exporter = new InMemorySpanExporter();

beforeAll(() => {
  const existing = trace.getTracerProvider();
  // The proxy returned by `getTracerProvider` after `.register()` exposes a
  // `getDelegate()` we can probe, but for our needs we just try to install a
  // new provider. If one is already installed, fall back to wiring our
  // exporter onto it.
  const fresh = new NodeTracerProvider();
  fresh.addSpanProcessor(new SimpleSpanProcessor(exporter));
  // register() only succeeds if no provider is set; either way we have our
  // exporter on `fresh` which we can use directly via fresh.getTracer().
  fresh.register();
  void existing;
});

test("daemon otel: chat_send → JSONL event → end_turn round-trips trace context", async () => {
  exporter.reset();

  // Step 1: pretend a hub sent us a chat_send with a parent traceparent.
  const parent = trace.getTracer("test-pwa").startSpan("pwa.user.sendChat");
  const parentCtx = injectFrame(parent.spanContext());
  parent.end();
  expect(parentCtx).toBeDefined();
  const parentTraceId = parentCtx!.traceparent.split("-")[1];

  // Step 2: daemon receives it, begins round-trip.
  const sessionId = "s-test-1";
  beginRoundTrip({
    spanName: "daemon.handleChat",
    sessionId,
    trace: parentCtx,
    attrs: { session_id: sessionId },
  });
  expect(getSessionMap().has(sessionId)).toBe(true);

  // Step 3: a JSONL line lands → daemon attaches a child span.
  const { trace: jsonlTrace } = withSessionChildSpan(
    sessionId,
    "daemon.jsonlEvent",
    { event_type: "assistant_message" },
    () => "ok",
  );
  expect(jsonlTrace).toBeDefined();
  // Critical: the child trace's trace_id matches the original parent's.
  // This is the load-bearing claim — without sessionMap, the JSONL event
  // would either have no parent or a fresh root.
  expect(jsonlTrace!.traceparent.split("-")[1]).toBe(parentTraceId);

  // Step 4: end_turn → end round trip.
  endRoundTrip(sessionId);
  expect(getSessionMap().has(sessionId)).toBe(false);

  disposeSessionMap();
});

test("daemon otel: withSessionChildSpan with no active root produces orphan, no throw", () => {
  const { trace: t, result } = withSessionChildSpan(
    "no-such-session",
    "daemon.jsonlEvent",
    {},
    () => 42,
  );
  expect(result).toBe(42);
  // Orphan span still gets a traceparent (its own trace_id).
  expect(t).toBeDefined();
  disposeSessionMap();
});
