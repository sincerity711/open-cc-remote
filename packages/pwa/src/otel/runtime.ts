// Tiny shim that lets non-OTel code call into OTel without statically
// importing the SDK chunks. The real `./index.ts` (with the OTel deps)
// is dynamically imported by main.tsx when VITE_OTEL_ENABLED=1; that
// code path patches the function pointers below.

import type { TraceCtx } from "@cc-remote/proto";

interface UserSpanResult<T> {
  result: T;
  trace: TraceCtx | undefined;
}

let userSpanImpl: <T>(
  name: string,
  attrs: Record<string, string | number | boolean>,
  fn: () => T,
) => UserSpanResult<T> = (_name, _attrs, fn) => ({ result: fn(), trace: undefined });

let renderSpanImpl: (
  frameType: string,
  inbound: TraceCtx | undefined,
  attrs?: Record<string, string | number | boolean>,
) => void = () => {};

export function installRuntime(impls: {
  startUserSpan: typeof userSpanImpl;
  recordRenderSpan: typeof renderSpanImpl;
}): void {
  userSpanImpl = impls.startUserSpan;
  renderSpanImpl = impls.recordRenderSpan;
}

export function startUserSpan<T>(
  name: string,
  attrs: Record<string, string | number | boolean>,
  fn: () => T,
): UserSpanResult<T> {
  return userSpanImpl(name, attrs, fn);
}

export function recordRenderSpan(
  frameType: string,
  inbound: TraceCtx | undefined,
  attrs: Record<string, string | number | boolean> = {},
): void {
  renderSpanImpl(frameType, inbound, attrs);
}
