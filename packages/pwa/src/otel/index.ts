// PWA-side OTel integration. Loaded as a separate chunk via dynamic
// import — only when VITE_OTEL_ENABLED=1.

import {
  trace,
  context,
  SpanKind,
  type Span,
  type SpanContext,
} from "@opentelemetry/api";
import { Resource } from "@opentelemetry/resources";
import {
  WebTracerProvider,
  BatchSpanProcessor,
} from "@opentelemetry/sdk-trace-web";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import type { TraceCtx } from "@cc-remote/proto";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { propagation } from "@opentelemetry/api";

let initialized = false;

interface InitArgs {
  collectorUrl: string;
}

export function initWebOtel({ collectorUrl }: InitArgs): void {
  if (initialized) return;
  const provider = new WebTracerProvider({
    resource: new Resource({ "service.name": "pwa" }),
  });
  // @ts-expect-error addSpanProcessor is published
  provider.addSpanProcessor(
    new BatchSpanProcessor(
      new OTLPTraceExporter({ url: `${collectorUrl.replace(/\/$/, "")}/v1/traces` }),
      { scheduledDelayMillis: 200 },
    ),
  );
  provider.register();
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  initialized = true;
}

function tracer() {
  return trace.getTracer("@cc-remote/pwa", "0.0.1");
}

/**
 * Open a `pwa.user.<name>` root span, run fn synchronously, end span,
 * and return the trace ctx that fn captured (the carrier is filled by
 * the global propagator with the active span's ids).
 *
 * No-op when initWebOtel hasn't been called: returns `{ trace: undefined,
 * result: fn() }`.
 */
export function startUserSpan<T>(
  name: string,
  attrs: Record<string, string | number | boolean>,
  fn: () => T,
): { result: T; trace: TraceCtx | undefined } {
  if (!initialized) return { result: fn(), trace: undefined };
  const span = tracer().startSpan(
    `pwa.user.${name}`,
    { kind: SpanKind.CLIENT, attributes: attrs },
  );
  const childCtx = trace.setSpan(context.active(), span);
  let result: T;
  try {
    result = context.with(childCtx, fn);
  } finally {
    span.end();
  }
  // Inject the just-finished span's context.
  const carrier: Record<string, string> = {};
  propagation.inject(trace.setSpanContext(context.active(), span.spanContext() as SpanContext), carrier);
  const traceparent = carrier["traceparent"];
  if (!traceparent) return { result, trace: undefined };
  return {
    result,
    trace: carrier["tracestate"]
      ? { traceparent, tracestate: carrier["tracestate"] }
      : { traceparent },
  };
}

/** Wrap an inbound frame's trace ctx in a brief render span. */
export function recordRenderSpan(
  frameType: string,
  inbound: TraceCtx | undefined,
  attrs: Record<string, string | number | boolean> = {},
): void {
  if (!initialized || !inbound) return;
  const carrier: Record<string, string> = { traceparent: inbound.traceparent };
  if (inbound.tracestate) carrier["tracestate"] = inbound.tracestate;
  const parentCtx = propagation.extract(context.active(), carrier);
  const span = tracer().startSpan(
    `pwa.render.${frameType}`,
    { kind: SpanKind.CLIENT, attributes: attrs },
    parentCtx,
  );
  span.end();
}

export function isOtelInitialized(): boolean {
  return initialized;
}
