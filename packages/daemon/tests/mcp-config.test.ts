import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureMcpConfig } from "../src/mcp-config.ts";

test("ensureMcpConfig creates a sane mcp-config.json on first run", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-mcp-"));
  try {
    const r = ensureMcpConfig({
      state_dir: dir,
      plugin_entry: "/abs/path/to/plugin/src/index.ts",
      socket_path: join(dir, "daemon.sock"),
      bun_path: "/usr/local/bin/bun",
    });
    expect(r.created).toBe(true);
    expect(r.path).toBe(join(dir, "mcp-config.json"));
    expect(existsSync(r.path)).toBe(true);
    const cfg = JSON.parse(readFileSync(r.path, "utf8"));
    expect(cfg.mcpServers["cc-remote"].command).toBe("/usr/local/bin/bun");
    expect(cfg.mcpServers["cc-remote"].args).toEqual(["run", "/abs/path/to/plugin/src/index.ts"]);
    expect(cfg.mcpServers["cc-remote"].env.CC_REMOTE_SOCKET).toBe(join(dir, "daemon.sock"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureMcpConfig leaves existing files untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-mcp-keep-"));
  try {
    const path = join(dir, "mcp-config.json");
    const userContent = JSON.stringify({ mcpServers: { other: { command: "x" } } }, null, 2);
    writeFileSync(path, userContent);
    const r = ensureMcpConfig({
      state_dir: dir,
      plugin_entry: "/p",
      socket_path: join(dir, "daemon.sock"),
      bun_path: "bun",
    });
    expect(r.created).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(userContent);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
