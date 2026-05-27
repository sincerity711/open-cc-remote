// Node-side OTel SDK bootstrap. PWA uses ./web.ts instead.
//
// Behavior:
//  - When OTEL_EXPORTER_OTLP_ENDPOINT is unset, returns a no-op shutdown
//    and never imports the SDK packages (lazy require keeps cold-start
//    cheap and avoids paying for OTel deps when disabled).
//  - When set, registers a NodeTracerProvider + OTLP HTTP trace exporter
//    and a LoggerProvider + OTLP HTTP log exporter.

import { setServiceName } from "./logger.ts";

interface InitArgs {
  serviceName: "daemon" | "hub" | "plugin" | "pwa" | string;
  /** Override OTEL_EXPORTER_OTLP_ENDPOINT for tests / programmatic use. */
  endpoint?: string;
  /** When passed, ignore env var and use this exporter instead. Tests use
   *  this with an in-memory exporter to avoid hitting a real collector. */
  testExporters?: {
    spanProcessor?: unknown;
    logProcessor?: unknown;
  };
}

let initialized = false;
let shutdownFn: () => Promise<void> = async () => {};

export function isOtelEnabled(): boolean {
  return initialized;
}

export async function initOtel(args: InitArgs): Promise<{ shutdown: () => Promise<void> }> {
  setServiceName(args.serviceName);
  const endpoint = args.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint && !args.testExporters) {
    // Disabled path. Logger still writes to stderr; tracer is a no-op.
    return { shutdown: async () => {} };
  }
  if (initialized) {
    return { shutdown: shutdownFn };
  }

  // Lazy imports — only paid when OTel is actually enabled.
  const { Resource } = await import("@opentelemetry/resources");
  const {
    NodeTracerProvider,
    BatchSpanProcessor,
  } = await import("@opentelemetry/sdk-trace-node");
  const { OTLPTraceExporter } = await import(
    "@opentelemetry/exporter-trace-otlp-http"
  );
  const { logs: otelLogsApi } = await import("@opentelemetry/api-logs");
  const { LoggerProvider, BatchLogRecordProcessor } = await import(
    "@opentelemetry/sdk-logs"
  );
  const { OTLPLogExporter } = await import(
    "@opentelemetry/exporter-logs-otlp-http"
  );

  const resource = new Resource({
    "service.name": args.serviceName,
  });

  // Trace pipeline
  const traceProvider = new NodeTracerProvider({ resource });
  const spanProcessor = (args.testExporters?.spanProcessor as
    | { onStart: () => void; onEnd: () => void; forceFlush: () => Promise<void>; shutdown: () => Promise<void> }
    | undefined) ??
    new BatchSpanProcessor(
      new OTLPTraceExporter({ url: `${endpoint!.replace(/\/$/, "")}/v1/traces` }),
      { scheduledDelayMillis: 200 },
    );

  traceProvider.addSpanProcessor(spanProcessor);
  traceProvider.register();

  // Log pipeline
  const logProvider = new LoggerProvider({ resource });
  const logProcessor = (args.testExporters?.logProcessor as
    | { onEmit: () => void; forceFlush: () => Promise<void>; shutdown: () => Promise<void> }
    | undefined) ??
    new BatchLogRecordProcessor(
      new OTLPLogExporter({ url: `${endpoint!.replace(/\/$/, "")}/v1/logs` }),
      { scheduledDelayMillis: 200 },
    );

  logProvider.addLogRecordProcessor(logProcessor);
  otelLogsApi.setGlobalLoggerProvider(logProvider);

  initialized = true;
  shutdownFn = async () => {
    try {
      await traceProvider.forceFlush();
      await traceProvider.shutdown();
      await logProvider.forceFlush();
      await logProvider.shutdown();
    } catch {
      // best-effort
    }
    initialized = false;
  };

  return { shutdown: shutdownFn };
}

export async function shutdownOtel(): Promise<void> {
  await shutdownFn();
}
