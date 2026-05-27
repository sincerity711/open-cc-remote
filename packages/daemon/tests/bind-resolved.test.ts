import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type Socket } from "node:net";
import { encodeFrame, FrameDecoder } from "@cc-remote/proto";
import type { PluginToDaemon, DaemonToPlugin, SessionSnapshot } from "@cc-remote/proto";
import { startSocketServer } from "../src/socket-server.ts";

/**
 * Smoke-level test: a register frame whose SessionSnapshot already carries
 * `claude_session_id` is preserved verbatim (it isn't stripped or rewritten
 * by the codec). Combined with the index.ts decision (skip bindJsonl when
 * pre-bound + JSONL exists), this is the wire-level half of #7.
 */
test("register with claude_session_id round-trips through the socket codec", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-bind-skip-"));
  const sockPath = join(dir, "d.sock");
  try {
    const received: PluginToDaemon[] = [];
    const server = startSocketServer({
      path: sockPath,
      onFrame: (f, c) => {
        received.push(f);
        if (f.type === "register") {
          server.replyTo(c, { type: "ack", ref: "register" });
        }
      },
    });
    await server.ready;

    const c: Socket = connect(sockPath);
    const decoder = new FrameDecoder();
    const acks: DaemonToPlugin[] = [];
    c.on("data", (b: Buffer) => {
      for (const f of decoder.push(b)) acks.push(f as DaemonToPlugin);
    });
    await new Promise<void>((res) => c.once("connect", () => res()));

    const session: SessionSnapshot = {
      session_id: "s1", claude_session_id: "uuid-claude-pre-bound",
      tmux_session: null, tmux_pane: null, cwd: "/x", model: null, pid: 1,
      started_at: 1, claude_client_version: "v", plugin_version: "v",
      state: "idle",
    };
    c.write(encodeFrame({ type: "register", session }));
    await new Promise((r) => setTimeout(r, 50));

    expect(received).toHaveLength(1);
    if (received[0]!.type !== "register") throw new Error("expected register");
    expect(received[0]!.session.claude_session_id).toBe("uuid-claude-pre-bound");
    expect(acks[0]).toEqual({ type: "ack", ref: "register" });

    c.end();
    server.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("daemon can push a bind_resolved frame to a registered plugin client", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-bind-resolved-"));
  const sockPath = join(dir, "d.sock");
  try {
    let pluginSocket: Socket | null = null;
    const server = startSocketServer({
      path: sockPath,
      onFrame: (f, c) => {
        if (f.type === "register") {
          pluginSocket = c;
          server.replyTo(c, { type: "ack", ref: "register" });
        }
      },
    });
    await server.ready;

    const c: Socket = connect(sockPath);
    const decoder = new FrameDecoder();
    const inbound: DaemonToPlugin[] = [];
    c.on("data", (b: Buffer) => {
      for (const f of decoder.push(b)) inbound.push(f as DaemonToPlugin);
    });
    await new Promise<void>((res) => c.once("connect", () => res()));

    const session: SessionSnapshot = {
      session_id: "s1", claude_session_id: null, tmux_session: null, tmux_pane: null,
      cwd: "/x", model: null, pid: 1, started_at: 1, claude_client_version: "v",
      plugin_version: "v", state: "idle",
    };
    c.write(encodeFrame({ type: "register", session }));
    // Wait for the daemon to record the socket.
    const start = Date.now();
    while (!pluginSocket && Date.now() - start < 1000) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(pluginSocket).not.toBeNull();

    server.replyTo(pluginSocket!, {
      type: "bind_resolved",
      session_id: "s1",
      claude_session_id: "uuid-claude-resolved",
    });
    await new Promise((r) => setTimeout(r, 30));
    const br = inbound.find((f) => f.type === "bind_resolved");
    expect(br).toBeTruthy();
    if (br && br.type === "bind_resolved") {
      expect(br.claude_session_id).toBe("uuid-claude-resolved");
    }

    c.end();
    server.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
