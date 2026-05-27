// Helpers for the OTel e2e: spin up Jaeger all-in-one alongside the
// regular demo compose, query its trace API, and assert structural
// shape. Used by tests/30-otel-trace.test.ts.

import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const composeDir = resolve(__dirname, "..");
const otelCompose = resolve(composeDir, "docker-compose.otel.yml");

const JAEGER_QUERY_BASE = "http://localhost:16686";

export async function upJaeger(): Promise<void> {
  const r = spawnSync(
    "docker",
    ["compose", "-f", otelCompose, "up", "-d", "--wait"],
    { cwd: composeDir, encoding: "utf8", timeout: 120_000 },
  );
  if (r.status !== 0) {
    throw new Error(`jaeger up failed: ${r.stdout}\n${r.stderr}`);
  }
  // Jaeger's healthcheck only covers the admin port. Wait until OTLP HTTP
  // returns *anything* before declaring ready.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch("http://localhost:4318/v1/traces", { method: "OPTIONS" });
      if (res.status < 500) return;
    } catch { /* keep polling */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("jaeger OTLP not reachable on :4318");
}

export async function downJaeger(): Promise<void> {
  spawnSync(
    "docker",
    ["compose", "-f", otelCompose, "down", "-v", "--remove-orphans", "-t", "5"],
    { cwd: composeDir, encoding: "utf8", timeout: 60_000 },
  );
}

export interface JaegerSpan {
  traceID: string;
  spanID: string;
  operationName: string;
  duration: number;
  references: { refType: string; traceID: string; spanID: string }[];
  tags: { key: string; type: string; value: unknown }[];
  processID: string;
}

export interface JaegerTrace {
  traceID: string;
  spans: JaegerSpan[];
  processes: Record<string, { serviceName: string }>;
}

interface JaegerSearchResponse {
  data: JaegerTrace[];
  errors: unknown;
}

/**
 * Poll Jaeger's search API until at least one trace with the given root
 * operation name surfaces.
 */
export async function waitForTrace(args: {
  service: string;
  operation: string;
  timeoutMs?: number;
}): Promise<JaegerTrace> {
  const deadline = Date.now() + (args.timeoutMs ?? 60_000);
  let lastBody = "";
  while (Date.now() < deadline) {
    const url = `${JAEGER_QUERY_BASE}/api/traces?service=${encodeURIComponent(args.service)}&operation=${encodeURIComponent(args.operation)}&limit=20&lookback=10m`;
    const res = await fetch(url);
    if (res.ok) {
      const body = (await res.json()) as JaegerSearchResponse;
      if (body.data && body.data.length > 0) {
        return body.data[0]!;
      }
      lastBody = JSON.stringify(body).slice(0, 200);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `waitForTrace(${args.service}/${args.operation}) timed out. last body=${lastBody}`,
  );
}

/** Get the full trace by id (for cross-service joins). */
export async function getTraceById(traceId: string): Promise<JaegerTrace> {
  const url = `${JAEGER_QUERY_BASE}/api/traces/${traceId}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`getTraceById ${traceId}: HTTP ${res.status}`);
  const body = (await res.json()) as JaegerSearchResponse;
  if (!body.data || body.data.length === 0) throw new Error(`no trace ${traceId}`);
  return body.data[0]!;
}

/** Convenience: list operation names per service. Helpful for diagnostics. */
export function spanNamesByService(trace: JaegerTrace): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const span of trace.spans) {
    const svc = trace.processes[span.processID]?.serviceName ?? "?";
    out[svc] ??= [];
    out[svc].push(span.operationName);
  }
  return out;
}

export const JAEGER_UI = JAEGER_QUERY_BASE;
