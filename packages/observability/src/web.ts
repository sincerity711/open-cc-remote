// PWA-side OTel bootstrap. Loaded only when VITE_OTEL_ENABLED=1 — the
// caller dynamically imports this module so the bundle stays slim when
// observability is off.

import { trace, type Tracer } from "@opentelemetry/api";
import { Resource } from "@opentelemetry/resources";
import {
  WebTracerProvider,
  BatchSpanProcessor,
} from "@opentelemetry/sdk-trace-web";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

let tracer: Tracer | null = null;

export interface WebOtelInit {
  serviceName: string;
  collectorUrl: string;
}

export function initWebOtel(args: WebOtelInit): void {
  if (tracer) return;
  const provider = new WebTracerProvider({
    resource: new Resource({ "service.name": args.serviceName }),
  });

  provider.addSpanProcessor(
    new BatchSpanProcessor(
      new OTLPTraceExporter({ url: `${args.collectorUrl.replace(/\/$/, "")}/v1/traces` }),
      { scheduledDelayMillis: 200 },
    ),
  );
  provider.register();
  tracer = trace.getTracer(args.serviceName);
}

export function getWebTracer(): Tracer {
  if (!tracer) tracer = trace.getTracer("@cc-remote/pwa-fallback");
  return tracer;
}
