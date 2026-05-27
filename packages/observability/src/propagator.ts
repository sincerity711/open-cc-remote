// W3C trace-context propagation helpers for our wire frames.
//
// Frames carry { traceparent, tracestate? } — the W3C standard. Helpers
// here stay framework-light: we read OpenTelemetry's API only when a real
// span is in scope; otherwise injectFrame returns undefined so the caller
// can omit the field.

import {
  context,
  propagation,
  trace,
  type Context,
  type SpanContext,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";

export interface TraceCtx {
  traceparent: string;
  tracestate?: string;
}

let installed = false;
function ensurePropagator(): void {
  if (installed) return;
  // It's safe to set the global propagator unconditionally — initOtel may
  // override it, but W3C is the standard either way.
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  installed = true;
}

/**
 * Inject the active span (or a passed span context) into a TraceCtx
 * suitable for embedding on a wire frame. Returns undefined if there is
 * no active span — call sites should `if (ctx) frame.trace = ctx`.
 */
export function injectFrame(spanCtx?: SpanContext): TraceCtx | undefined {
  ensurePropagator();
  const carrier: Record<string, string> = {};
  let ctx = context.active();
  if (spanCtx) {
    ctx = trace.setSpanContext(ctx, spanCtx);
  }
  propagation.inject(ctx, carrier);
  const traceparent = carrier["traceparent"];
  if (!traceparent) return undefined;
  const tracestate = carrier["tracestate"];
  return tracestate ? { traceparent, tracestate } : { traceparent };
}

/**
 * Extract a parent context from a TraceCtx received on the wire.
 * Returns ROOT_CONTEXT if the input is missing/invalid.
 */
export function extractContext(traceCtx: TraceCtx | undefined): Context {
  ensurePropagator();
  if (!traceCtx) return context.active();
  const carrier: Record<string, string> = { traceparent: traceCtx.traceparent };
  if (traceCtx.tracestate) carrier["tracestate"] = traceCtx.tracestate;
  return propagation.extract(context.active(), carrier);
}
