import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { startSocketServer } from "../../daemon/src/socket-server.ts";

interface JsonRpc { jsonrpc: "2.0"; id?: number | string; method?: string; params?: unknown; result?: unknown; error?: unknown; }

async function withChild<T>(child: ChildProcess, fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } finally { child.kill("SIGTERM"); }
}

function send(child: ChildProcess, msg: JsonRpc) {
  child.stdin!.write(JSON.stringify(msg) + "\n");
}

function readLines(child: ChildProcess, onMsg: (m: JsonRpc) => void): void {
  let buf = "";
  child.stdout!.on("data", (b: Buffer) => {
    buf += b.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try { onMsg(JSON.parse(line) as JsonRpc); } catch {}
    }
  });
}

test("plugin handshake: initialize → capabilities + tools/list returns reply", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-mcp-init-"));
  const sockPath = join(dir, "d.sock");
  try {
    const server = startSocketServer({
      path: sockPath,
      onFrame: (f, c) => {
        if (f.type === "register" || f.type === "bye") server.replyTo(c, { type: "ack", ref: f.type });
      },
    });
    await server.ready;

    const child = spawn("bun", ["run", join(import.meta.dir, "..", "src", "index.ts")], {
      env: { ...process.env, CC_REMOTE_SOCKET: sockPath, CLAUDE_PROJECT_DIR: dir },
      stdio: ["pipe", "pipe", "inherit"],
    });

    await withChild(child, async () => {
      const messages: JsonRpc[] = [];
      readLines(child, (m) => messages.push(m));

      send(child, {
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-host", version: "9.9.9" },
        },
      });
      send(child, { jsonrpc: "2.0", method: "notifications/initialized" });

      const initResp = await waitFor(() => messages.find((m) => m.id === 1) ?? null, 3000, "initialize response");
      const result = initResp.result as any;
      expect(result.serverInfo.name).toBe("cc-remote");
      expect(result.capabilities.experimental["claude/channel"]).toBeDefined();
      expect(result.capabilities.experimental["claude/channel/permission"]).toBeDefined();

      send(child, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      const tools = await waitFor(() => messages.find((m) => m.id === 2) ?? null, 3000, "tools/list response");
      const toolList = (tools.result as any).tools as Array<{ name: string }>;
      expect(toolList.map((t) => t.name)).toEqual(["reply"]);
    });

    server.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function waitFor<T>(pred: () => T | null, timeoutMs: number, label: string): Promise<T> {
  const start = Date.now();
  while (true) {
    const v = pred();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
