import { test, expect } from "bun:test";
import { startHubClient } from "../src/hub-client.ts";
import type { DaemonToHub } from "@cc-remote/proto";

test("connects, sends hello on open, reconnects on server close", async () => {
  const helloEvents: DaemonToHub[] = [];
  let firstSocket: any = null; let connectCount = 0;

  const server = Bun.serve<{ first: boolean }>({
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname !== "/ws/daemon") return new Response("nope", { status: 404 });
      const ok = srv.upgrade(req, { data: { first: connectCount === 0 } });
      return ok ? undefined : new Response("upgrade fail", { status: 500 });
    },
    websocket: {
      open(ws) {
        connectCount++;
        if (ws.data.first) firstSocket = ws;
      },
      message(ws, msg) {
        helloEvents.push(JSON.parse(typeof msg === "string" ? msg : msg.toString()) as DaemonToHub);
      },
      close() {},
    },
  });

  try {
    const client = startHubClient({
      hub_url: `ws://localhost:${server.port}`,
      daemon_id: "d-1",
      hello: () => ({ type: "hello", daemon_id: "d-1", epoch: 1,
        hostname: "h", agent_version: "0", sessions: [] }),
      onFrame: () => {},
      backoffStartMs: 50,
      backoffCapMs: 200,
    });

    // Wait for first hello.
    await waitFor(() => helloEvents.length === 1, 2000);
    expect(helloEvents[0]).toMatchObject({ type: "hello", daemon_id: "d-1" });

    // Force-close from server side.
    firstSocket.close(1011, "test-disconnect");
    // Expect a reconnection and a second hello.
    await waitFor(() => helloEvents.length === 2, 2000);
    expect(connectCount).toBeGreaterThanOrEqual(2);

    client.close();
  } finally {
    server.stop(true);
  }
});

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}
