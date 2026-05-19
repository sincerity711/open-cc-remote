import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { startSocketServer } from "../../daemon/src/socket-server.ts";
import type { PluginToDaemon } from "@cc-remote/proto";

interface JsonRpc { jsonrpc: "2.0"; id?: number | string; method?: string; params?: unknown; result?: unknown; }

async function waitFor<T>(pred: () => T | null, timeoutMs: number, label: string): Promise<T> {
  const start = Date.now();
  while (true) {
    const v = pred();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

test("plugin permission relay: CC notif → daemon frame → daemon reply → CC notif", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-perm-"));
  const sockPath = join(dir, "d.sock");
  try {
    const seen: PluginToDaemon[] = [];
    let pluginSocket: any = null;
    const server = startSocketServer({
      path: sockPath,
      onFrame: (f, c) => {
        seen.push(f);
        pluginSocket = c;
        if (f.type === "register" || f.type === "bye") server.replyTo(c, { type: "ack", ref: f.type });
      },
    });
    await server.ready;

    const child: ChildProcess = spawn("bun", ["run", join(import.meta.dir, "..", "src", "index.ts")], {
      env: { ...process.env, CC_REMOTE_SOCKET: sockPath, CLAUDE_PROJECT_DIR: dir },
      stdio: ["pipe", "pipe", "inherit"],
    });

    try {
      const messages: JsonRpc[] = [];
      let buf = "";
      child.stdout!.on("data", (b: Buffer) => {
        buf += b.toString("utf8");
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try { messages.push(JSON.parse(line) as JsonRpc); } catch {}
        }
      });

      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "9.9.9" } } }) + "\n");
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      await waitFor(() => seen.find((f) => f.type === "register") ?? null, 3000, "register frame");

      child.stdin!.write(JSON.stringify({
        jsonrpc: "2.0", method: "notifications/claude/channel/permission_request",
        params: { request_id: "abcde", tool_name: "Bash", description: "rm -rf", input_preview: "rm -rf /tmp/x" },
      }) + "\n");

      const fwd = await waitFor(() => seen.find((f) => f.type === "permission_request") ?? null, 3000, "forwarded permission_request");
      expect((fwd as any).request_id).toBe("abcde");
      expect((fwd as any).tool).toBe("Bash");
      expect((fwd as any).args_summary).toBe("rm -rf /tmp/x");

      server.replyTo(pluginSocket, { type: "permission_reply", request_id: "abcde", decision: "allow" });

      const out = await waitFor(() => messages.find((m) => m.method === "notifications/claude/channel/permission") ?? null, 3000, "outbound permission notif");
      expect((out.params as any).request_id).toBe("abcde");
      expect((out.params as any).behavior).toBe("allow");
    } finally {
      child.kill("SIGTERM");
    }

    server.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
