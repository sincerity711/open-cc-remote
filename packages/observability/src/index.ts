// Public re-exports for Node-side consumers (daemon, hub, plugin).

export { initOtel, shutdownOtel, isOtelEnabled } from "./init.ts";
export { log, setServiceName } from "./logger.ts";
export { SessionMap, type ActiveTrace } from "./session-map.ts";
export { injectFrame, extractContext, type TraceCtx } from "./propagator.ts";
