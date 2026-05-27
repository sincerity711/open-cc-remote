// Logger: the one place every process emits human-readable lines.
//
// Behavior:
//  - Always writes a line to process.stderr (preserves the local debug
//    workflow: `tail -f /tmp/cc-remote-demo/daemon.log`).
//  - When the OTel logs SDK is initialized (initOtel called with an OTLP
//    endpoint), additionally emits an OTLP log record. The SDK injects
//    trace_id + span_id from the active context automatically.
//  - When OTel is disabled, this module never imports the OTel SDK.

import { logs as otelLogs, SeverityNumber, type Logger as OtelLogger } from "@opentelemetry/api-logs";

let serviceName = "unknown";
let cachedLogger: OtelLogger | null = null;

export function setServiceName(name: string): void {
  serviceName = name;
  cachedLogger = null; // re-resolve on next emit
}

function getOtelLogger(): OtelLogger | null {
  if (!cachedLogger) {
    // logs.getLogger() returns a no-op logger if no provider is registered;
    // we still memo to avoid re-resolving every call.
    try {
      cachedLogger = otelLogs.getLogger("@cc-remote/observability", "0.0.1");
    } catch {
      cachedLogger = null;
    }
  }
  return cachedLogger;
}

function emit(
  level: "info" | "warn" | "error",
  msg: string,
  attrs: Record<string, unknown> | undefined,
): void {
  const tail = attrs && Object.keys(attrs).length ? " " + JSON.stringify(attrs) : "";
  process.stderr.write(`${level} ${serviceName}: ${msg}${tail}\n`);

  const logger = getOtelLogger();
  if (logger) {
    logger.emit({
      severityNumber:
        level === "error"
          ? SeverityNumber.ERROR
          : level === "warn"
            ? SeverityNumber.WARN
            : SeverityNumber.INFO,
      severityText: level.toUpperCase(),
      body: msg,
      attributes: attrs as Record<string, string | number | boolean> | undefined,
    });
  }
}

export const log = {
  info(msg: string, attrs?: Record<string, unknown>): void {
    emit("info", msg, attrs);
  },
  warn(msg: string, attrs?: Record<string, unknown>): void {
    emit("warn", msg, attrs);
  },
  error(msg: string, attrs?: Record<string, unknown>): void {
    emit("error", msg, attrs);
  },
};
