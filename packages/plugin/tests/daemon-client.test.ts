import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSocketServer } from "../../daemon/src/socket-server.ts";
import { connectDaemon } from "../src/daemon-client.ts";
import type { PluginToDaemon } from "@cc-remote/proto";

test("connect, register, bye, close round-trip", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-pc-"));
  const sockPath = join(dir, "d.sock");
  try {
    const seen: PluginToDaemon[] = [];
    const server = startSocketServer({
      path: sockPath,
      onFrame: (f, c) => { seen.push(f); server.replyTo(c, { type: "ack", ref: f.type as "register" | "bye" }); },
    });
    await server.ready;

    const client = await connectDaemon(sockPath);
    const ack1 = await client.send({
      type: "register",
      session: { session_id: "s1", claude_session_id: null, tmux_session: null, tmux_pane: null,
                 cwd: "/x", model: "m", pid: 1, started_at: 1,
                 claude_client_version: "test", plugin_version: "0.0.0" }
    });
    expect(ack1).toEqual({ type: "ack", ref: "register" });

    const ack2 = await client.send({ type: "bye", session_id: "s1" });
    expect(ack2).toEqual({ type: "ack", ref: "bye" });

    client.close();
    server.close();
    expect(seen.map((f) => f.type)).toEqual(["register", "bye"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
