import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";

test("loadConfig reads daemon_id and hub_url from JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-"));
  try {
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      daemon_id: "macbook-pro",
      hub_url: "ws://localhost:7745",
    }));
    const cfg = loadConfig(dir);
    expect(cfg.daemon_id).toBe("macbook-pro");
    expect(cfg.hub_url).toBe("ws://localhost:7745");
    expect(cfg.socket_path).toBe(join(dir, "daemon.sock"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig throws when file missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-"));
  try {
    expect(() => loadConfig(dir)).toThrow(/config\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
