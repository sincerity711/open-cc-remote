import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSocketServer } from "../../daemon/src/socket-server.ts";
import { connectDaemonReconnecting } from "../src/daemon-client.ts";
import type { PluginToDaemon, SessionSnapshot } from "@cc-remote/proto";

const SESSION: SessionSnapshot = {
  session_id: "s-reconnect",
  claude_session_id: null,
  tmux_session: null,
  tmux_pane: null,
  cwd: "/x",
  model: "m",
  pid: 1,
  started_at: 1,
  claude_client_version: "test",
  plugin_version: "0.0.0",
  state: "idle",
};

async function waitFor<T>(pred: () => T | null | undefined, timeoutMs: number, label: string): Promise<T> {
  const start = Date.now();
  while (true) {
    const v = pred();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("connectDaemonReconnecting reconnects after server restart and fires onReconnected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-reconn-"));
  const sockPath = join(dir, "d.sock");
  try {
    const framesA: PluginToDaemon[] = [];
    const serverA = startSocketServer({
      path: sockPath,
      onFrame: (f, c) => {
        framesA.push(f);
        if (f.type === "register") serverA.replyTo(c, { type: "ack", ref: "register" });
      },
    });
    await serverA.ready;

    let reconnected = 0;
    let disconnects = 0;
    const client = await connectDaemonReconnecting(sockPath, {
      backoffStartMs: 30,
      backoffCapMs: 200,
      onDisconnected: () => { disconnects += 1; },
      onReconnected: () => { reconnected += 1; },
    });

    // Initial register lands on server A.
    const ack1 = await client.send({ type: "register", session: SESSION });
    expect(ack1).toEqual({ type: "ack", ref: "register" });
    await waitFor(() => (framesA.length === 1 ? framesA : null), 1000, "frame on serverA");

    // Kill server A — simulates daemon restart.
    serverA.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(disconnects).toBe(1);

    // Bring server B back up on the same socket path.
    const framesB: PluginToDaemon[] = [];
    const serverB = startSocketServer({
      path: sockPath,
      onFrame: (f, c) => {
        framesB.push(f);
        if (f.type === "register") serverB.replyTo(c, { type: "ack", ref: "register" });
      },
    });
    await serverB.ready;

    // The client should reconnect on its own within a few backoff cycles.
    await waitFor(() => (reconnected >= 1 ? true : null), 3000, "client reconnect");

    // The reconnected client can talk to server B.
    const ack2 = await client.send({ type: "register", session: SESSION });
    expect(ack2).toEqual({ type: "ack", ref: "register" });
    await waitFor(() => (framesB.length >= 1 ? framesB : null), 1000, "frame on serverB");

    client.close();
    serverB.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("connectDaemonReconnecting drops sends while disconnected without hanging", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-reconn-drop-"));
  const sockPath = join(dir, "d.sock");
  try {
    const server = startSocketServer({
      path: sockPath,
      onFrame: (f, c) => {
        if (f.type === "register") server.replyTo(c, { type: "ack", ref: "register" });
      },
    });
    await server.ready;

    const client = await connectDaemonReconnecting(sockPath, {
      backoffStartMs: 50,
      backoffCapMs: 200,
    });
    await client.send({ type: "register", session: SESSION });

    // Drop the server. While disconnected, send() must resolve quickly with a
    // synthetic ack — never hang Claude waiting on a dead socket.
    server.close();
    await new Promise((r) => setTimeout(r, 50));

    const start = Date.now();
    const ack = await client.send({ type: "bye", session_id: SESSION.session_id });
    const elapsed = Date.now() - start;
    expect(ack).toMatchObject({ type: "ack" });
    expect(elapsed).toBeLessThan(200);

    client.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("connectDaemonReconnecting throws if the very first connect fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-reconn-init-"));
  const sockPath = join(dir, "nope.sock");
  try {
    let threw = false;
    try {
      await connectDaemonReconnecting(sockPath, { initialTimeoutMs: 100 });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
