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

test("plugin chat: reply tool sends chat_out; chat_in becomes channel notification", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-chat-"));
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
        if (f.type === "chat_out") server.replyTo(c, { type: "ack", ref: "chat_out" });
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
      const reg = await waitFor(() => seen.find((f) => f.type === "register") ?? null, 3000, "register") as any;
      const sid = reg.session.session_id;

      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "reply", arguments: { text: "hello pwa" } } }) + "\n");
      const out = await waitFor(() => seen.find((f) => f.type === "chat_out") ?? null, 3000, "chat_out frame") as any;
      expect(out.session_id).toBe(sid);
      expect(out.content).toBe("hello pwa");
      expect(out.reply_to).toBeNull();
      const reply = await waitFor(() => messages.find((m) => m.id === 2) ?? null, 3000, "tools/call response");
      expect(((reply.result as any).content as any[])[0].text).toBe("delivered");

      server.replyTo(pluginSocket, {
        type: "chat_in",
        session_id: sid,
        message_id: "m1",
        user: "alice@sap.com",
        user_id: "u-1",
        content: "hi from pwa",
        ts: 1700000000,
      });
      const notif = await waitFor(() => messages.find((m) => m.method === "notifications/claude/channel") ?? null, 3000, "channel notif");
      const p = notif.params as any;
      expect(p.content).toBe("hi from pwa");
      expect(p.meta.message_id).toBe("m1");
      expect(p.meta.user).toBe("alice@sap.com");
      expect(p.meta.chat_id).toBe("pwa");
      // meta.ts MUST be an ISO 8601 string — Claude Code's Zod schema for
      // notifications/claude/channel rejects non-strings and silently drops
      // the notification, breaking channel relay end-to-end. The frame ts
      // input here is unix seconds (1700000000); the plugin must convert.
      expect(typeof p.meta.ts).toBe("string");
      expect(p.meta.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(new Date(p.meta.ts).getTime()).toBe(1700000000 * 1000);
    } finally { child.kill("SIGTERM"); }

    server.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
