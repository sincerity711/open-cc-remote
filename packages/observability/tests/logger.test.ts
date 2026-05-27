import { test, expect, beforeEach } from "bun:test";
import { log, setServiceName } from "../src/logger.ts";

let captured: string[] = [];
const origWrite = process.stderr.write.bind(process.stderr);

beforeEach(() => {
  captured = [];

  process.stderr.write = (chunk: string | Uint8Array) => {
    captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  };
  setServiceName("test-svc");
});

test("logger: info writes a single stderr line with service prefix", () => {
  log.info("hello");

  process.stderr.write = origWrite;
  expect(captured.length).toBe(1);
  expect(captured[0]).toBe("info test-svc: hello\n");
});

test("logger: attrs are JSON-stringified after the message", () => {
  log.warn("oops", { x: 1, y: "z" });

  process.stderr.write = origWrite;
  expect(captured[0]).toBe('warn test-svc: oops {"x":1,"y":"z"}\n');
});

test("logger: empty attrs object does not produce trailing space", () => {
  log.error("bad", {});

  process.stderr.write = origWrite;
  expect(captured[0]).toBe("error test-svc: bad\n");
});

test("logger: setServiceName changes the prefix", () => {
  setServiceName("daemon");
  log.info("up");

  process.stderr.write = origWrite;
  expect(captured[0]).toBe("info daemon: up\n");
});
