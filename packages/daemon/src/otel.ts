// Daemon-side OTel helpers. The hot path in index.ts calls these to:
//  - start the round-trip's root span when a chat_send (or other forward
//    frame) arrives, and pin it on the SessionMap.
//  - attach JSONL-driven outbound events as child spans on the active
//    trace by peeking the SessionMap.
//  - end the root span when the assistant emits stop_reason=end_turn.
//
// Designed to be safe when OTel is disabled: the tracer falls back to the
// global no-op tracer and the SessionMap stays in use as a plain bookkeeping
// device (push/peek still work, end() is a no-op).

import {
  trace,
  context,
  SpanKind,
  type Span,
  type SpanContext,
  type Tracer,
} from "@opentelemetry/api";
import { extractContext, injectFrame, SessionMap, type TraceCtx } from "@cc-remote/observability";

let sessionMap: SessionMap | null = null;

export function getSessionMap(): SessionMap {
  if (!sessionMap) sessionMap = new SessionMap();
  return sessionMap;
}

export function disposeSessionMap(): void {
  sessionMap?.dispose();
  sessionMap = null;
}

function tracer(): Tracer {
  return trace.getTracer("@cc-remote/daemon", "0.0.1");
}

/**
 * Begin a round-trip trace for an inbound forward frame (chat_send,
 * start_session, etc). Pushes the root span onto SessionMap[sessionId].
 *
 * Returns a function that, when called, ends the per-handler span (NOT
 * the root). The root is ended by `endRoundTrip(sessionId)` once
 * stop_reason arrives.
 */
export function beginRoundTrip(args: {
  spanName: string;
  sessionId: string;
  trace: TraceCtx | undefined;
  attrs?: Record<string, string | number | boolean>;
}): { handlerSpan: Span; rootSpan: Span; endHandler: () => void } {
  const parentCtx = extractContext(args.trace);
  // The root span IS the handler span — we keep it open for the whole
  // round-trip and let JSONL events become children of it.
  const rootSpan = tracer().startSpan(
    args.spanName,
    { kind: SpanKind.SERVER, attributes: args.attrs },
    parentCtx,
  );
  const rootCtx = trace.setSpan(parentCtx, rootSpan);
  getSessionMap().push(args.sessionId, { rootCtx, rootSpan });
  return {
    handlerSpan: rootSpan,
    rootSpan,
    endHandler: () => {
      // No-op: the root span stays open until endRoundTrip().
    },
  };
}

/**
 * Run `fn` inside a child span attached to the active root for sessionId.
 * If no active root, runs `fn` with no parent (the resulting orphan span
 * is fine — it just won't appear under the round-trip tree).
 *
 * Returns the trace ctx of the child span, suitable for injecting into
 * an outbound frame.
 */
export function withSessionChildSpan<T>(
  sessionId: string,
  spanName: string,
  attrs: Record<string, string | number | boolean> | undefined,
  fn: (span: Span) => T,
): { result: T; trace: TraceCtx | undefined } {
  const active = getSessionMap().peek(sessionId);
  const parentCtx = active ? active.rootCtx : context.active();
  const span = tracer().startSpan(spanName, { attributes: attrs, kind: SpanKind.INTERNAL }, parentCtx);
  const childCtx = trace.setSpan(parentCtx, span);
  let result: T;
  try {
    result = context.with(childCtx, () => fn(span));
  } catch (e) {
    span.recordException(e as Error);
    span.end();
    throw e;
  }
  const traceCtx = injectFrame(span.spanContext() as SpanContext);
  span.end();
  return { result, trace: traceCtx };
}

/** End and pop the round-trip root for sessionId (if any). */
export function endRoundTrip(sessionId: string): void {
  const popped = getSessionMap().pop(sessionId);
  if (popped) {
    try {
      popped.rootSpan.end();
    } catch {
      // ignore
    }
  }
}
