import { test, expect } from "bun:test";
import { trace, context, SpanKind } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { Resource } from "@opentelemetry/resources";
import { injectFrame, extractContext } from "../src/propagator.ts";

let providerSetup = false;
function setupProvider(): InMemorySpanExporter {
  const exporter = new InMemorySpanExporter();
  if (providerSetup) return exporter;
  const provider = new NodeTracerProvider({ resource: new Resource({ "service.name": "test" }) });

  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
  provider.register();
  providerSetup = true;
  return exporter;
}

test("propagator: injectFrame returns undefined when no active span", () => {
  setupProvider();
  const ctx = injectFrame();
  // No active span → no traceparent.
  expect(ctx).toBeUndefined();
});

test("propagator: injectFrame inside startActiveSpan returns a valid traceparent", () => {
  setupProvider();
  const tracer = trace.getTracer("t");
  let captured: ReturnType<typeof injectFrame> = undefined;
  tracer.startActiveSpan("root", { kind: SpanKind.INTERNAL }, (span) => {
    captured = injectFrame();
    span.end();
  });
  expect(captured).toBeDefined();
  expect(captured!.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[01]{2}$/);
});

test("propagator: extract → setActiveContext → injectFrame produces same trace_id", () => {
  setupProvider();
  const tracer = trace.getTracer("t");

  // Stage 1: original side produces a traceparent.
  let original: ReturnType<typeof injectFrame> = undefined;
  tracer.startActiveSpan("origin", (span) => {
    original = injectFrame();
    span.end();
  });
  expect(original).toBeDefined();
  const originalTraceId = original!.traceparent.split("-")[1];

  // Stage 2: receiver side extracts and starts a child.
  const parentCtx = extractContext(original);
  let childParent: ReturnType<typeof injectFrame> = undefined;
  context.with(parentCtx, () => {
    tracer.startActiveSpan("child", (span) => {
      childParent = injectFrame();
      span.end();
    });
  });
  expect(childParent).toBeDefined();
  const childTraceId = childParent!.traceparent.split("-")[1];
  expect(childTraceId).toBe(originalTraceId);
});

test("propagator: extractContext on undefined input is safe", () => {
  // Should not throw.
  const ctx = extractContext(undefined);
  expect(ctx).toBeDefined();
});
