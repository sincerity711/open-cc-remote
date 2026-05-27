import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { Socket } from "node:net";
import { startSocketServer } from "../../daemon/src/socket-server.ts";
import type { PluginToDaemon } from "@cc-remote/proto";

interface JsonRpc { jsonrpc: "2.0"; id?: number | string; method?: string; params?: unknown; result?: unknown; error?: unknown; }

function send(child: ChildProcess, msg: JsonRpc) {
  child.stdin!.write(JSON.stringify(msg) + "\n");
}

async function waitFor<T>(pred: () => T | null | undefined, timeoutMs: number, label: string): Promise<T> {
  const start = Date.now();
  while (true) {
    const v = pred();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * Item #7: after the daemon resolves claude_session_id and pushes
 * bind_resolved, the plugin caches it on its registeredSession copy.
 * On daemon restart, the auto-reconnect re-sends `register` and we
 * verify the new daemon receives the resolved id (so it can skip
 * bindJsonl and start the watcher directly).
 */
test("plugin caches claude_session_id from bind_resolved and replays it on reconnect", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-bind-replay-"));
  const sockPath = join(dir, "d.sock");
  try {
    let pluginSockA: Socket | null = null;
    const framesA: PluginToDaemon[] = [];
    const serverA = startSocketServer({
      path: sockPath,
      onFrame: (f, c) => {
        framesA.push(f);
        if (f.type === "register") {
          pluginSockA = c;
          serverA.replyTo(c, { type: "ack", ref: "register" });
        } else if (f.type === "bye") {
          serverA.replyTo(c, { type: "ack", ref: "bye" });
        }
      },
    });
    await serverA.ready;

    const child = spawn("bun", ["run", join(import.meta.dir, "..", "src", "index.ts")], {
      env: { ...process.env, CC_REMOTE_SOCKET: sockPath, CLAUDE_PROJECT_DIR: dir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      // Drive MCP initialize so the plugin sends `register`.
      send(child, {
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-host", version: "9.9.9" },
        },
      });
      send(child, { jsonrpc: "2.0", method: "notifications/initialized" });

      const reg1 = await waitFor(
        () => framesA.find((f) => f.type === "register") ?? null,
        3000,
        "first register on serverA",
      );
      if (reg1.type !== "register") throw new Error("not register");
      const sessionId = reg1.session.session_id;
      // Fresh register has null claude_session_id.
      expect(reg1.session.claude_session_id).toBeNull();

      // Server pushes bind_resolved — plugin should patch its cached session.
      await waitFor(() => pluginSockA, 1000, "plugin socket");
      serverA.replyTo(pluginSockA!, {
        type: "bind_resolved",
        session_id: sessionId,
        claude_session_id: "uuid-claude-resolved",
      });
      // Give the plugin a tick to process the frame.
      await new Promise((r) => setTimeout(r, 100));

      // Bring server A down, simulate daemon restart with server B.
      serverA.close();
      await new Promise((r) => setTimeout(r, 80));

      const framesB: PluginToDaemon[] = [];
      const serverB = startSocketServer({
        path: sockPath,
        onFrame: (f, c) => {
          framesB.push(f);
          if (f.type === "register") serverB.replyTo(c, { type: "ack", ref: "register" });
          else if (f.type === "bye") serverB.replyTo(c, { type: "ack", ref: "bye" });
        },
      });
      await serverB.ready;

      // The plugin should re-send register with the cached claude_session_id.
      const reg2 = await waitFor(
        () => framesB.find((f) => f.type === "register") ?? null,
        5000,
        "re-register on serverB",
      );
      if (reg2.type !== "register") throw new Error("not register");
      expect(reg2.session.session_id).toBe(sessionId);
      expect(reg2.session.claude_session_id).toBe("uuid-claude-resolved");
      serverB.close();
    } finally {
      child.kill("SIGTERM");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
