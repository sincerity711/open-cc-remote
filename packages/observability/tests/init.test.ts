import { test, expect } from "bun:test";
import { initOtel, shutdownOtel, isOtelEnabled } from "../src/init.ts";

test("init: with no endpoint env, isOtelEnabled stays false and returns no-op shutdown", async () => {
  const prev = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  try {
    const { shutdown } = await initOtel({ serviceName: "test" });
    expect(isOtelEnabled()).toBe(false);
    await shutdown();
    await shutdownOtel();
  } finally {
    if (prev !== undefined) process.env.OTEL_EXPORTER_OTLP_ENDPOINT = prev;
  }
});
