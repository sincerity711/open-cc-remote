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

test("loadConfig allow_kill defaults to false; honors true", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-c2-"));
  try {
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      daemon_id: "d", hub_url: "ws://x",
    }));
    expect(loadConfig(dir).allow_kill).toBe(false);

    writeFileSync(join(dir, "config.json"), JSON.stringify({
      daemon_id: "d", hub_url: "ws://x", allow_kill: true,
    }));
    expect(loadConfig(dir).allow_kill).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig allow_start + allowed_cwd_prefix + spawn_command have defaults; honor overrides", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-c3-"));
  try {
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      daemon_id: "d", hub_url: "ws://x",
    }));
    const c1 = loadConfig(dir);
    expect(c1.allow_start).toBe(false);
    expect(c1.allowed_cwd_prefix).toEqual([]);
    expect(c1.spawn_command).toContain("claude");

    writeFileSync(join(dir, "config.json"), JSON.stringify({
      daemon_id: "d", hub_url: "ws://x",
      allow_start: true,
      allowed_cwd_prefix: ["/Users/me/work"],
      spawn_command: "echo hi",
    }));
    const c2 = loadConfig(dir);
    expect(c2.allow_start).toBe(true);
    expect(c2.allowed_cwd_prefix).toEqual(["/Users/me/work"]);
    expect(c2.spawn_command).toBe("echo hi");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
