// Hub-side OTel helper. Single span — `hub.routeFrame` — wraps each
// cross-direction forward and re-injects a child trace context into the
// outbound frame so both downstream and broadcast paths stay attached.

import {
  trace,
  context,
  SpanKind,
  type Span,
  type SpanContext,
} from "@opentelemetry/api";
import { extractContext, injectFrame, type TraceCtx } from "@cc-remote/observability";

function tracer() {
  return trace.getTracer("@cc-remote/hub", "0.0.1");
}

/**
 * Run `fn` inside a `hub.routeFrame` span attached to the inbound
 * frame's trace context. The child span's context is exposed to `fn`
 * via the `outboundTrace` argument, so the caller can stamp it on
 * outbound frames.
 */
export function routeFrameSpan<T>(
  inbound: TraceCtx | undefined,
  attrs: Record<string, string | number | boolean>,
  fn: (outboundTrace: TraceCtx | undefined) => T,
): T {
  const parentCtx = extractContext(inbound);
  const span = tracer().startSpan(
    "hub.routeFrame",
    { kind: SpanKind.SERVER, attributes: attrs },
    parentCtx,
  );
  const childCtx = trace.setSpan(parentCtx, span);
  const outbound = injectFrame(span.spanContext() as SpanContext);
  try {
    return context.with(childCtx, () => fn(outbound));
  } finally {
    span.end();
  }
}
