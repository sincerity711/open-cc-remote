import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { makeServer } from "../src/routes.ts";

interface FakeWsData {
  kind: "daemon" | "pwa";
  key: string;
  user?: string;
  user_id?: string;
  lastFrameAt: number;
}

interface FakeWs {
  data: FakeWsData;
  sent: string[];
  closed: { code: number; reason: string } | null;
  send(payload: string): void;
  close(code: number, reason: string): void;
}

function mkFakeWs(data: Partial<FakeWsData> & { kind: "daemon" | "pwa"; key: string }): FakeWs {
  const ws: FakeWs = {
    data: { lastFrameAt: Date.now(), ...data } as FakeWsData,
    sent: [],
    closed: null,
    send(p: string) { this.sent.push(p); },
    close(code: number, reason: string) { this.closed = { code, reason }; },
  };
  return ws;
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "ccr-hb-"));
  const db = openDb(join(dir, "h.sqlite"));
  const server = makeServer({ db, jwt_secret: "s", disable_auth: true });
  return {
    server,
    cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("ping frame from daemon → pong response, lastFrameAt updated, not forwarded to router", () => {
  const s = setup();
  try {
    // Pretend a daemon ws exists. We bypass `open` (which would require
    // a real Bun upgrade) and call `message` directly with a stub ws.
    const ws = mkFakeWs({ kind: "daemon", key: "d1" });
    const before = ws.data.lastFrameAt;

    // Simulate the wall clock advancing slightly so `before < after`.
    ws.data.lastFrameAt = before - 1000;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    s.server.websocket.message(ws as any, JSON.stringify({ type: "ping", ts: 12345 }));

    expect(ws.sent.length).toBe(1);
    const pong = JSON.parse(ws.sent[0] as string) as { type: string; ts: number };
    expect(pong.type).toBe("pong");
    expect(pong.ts).toBe(12345);
    expect(ws.data.lastFrameAt).toBeGreaterThan(before - 1000);
    // Closed should not have been called (ping doesn't crash bad-json branch).
    expect(ws.closed).toBeNull();
  } finally { s.cleanup(); }
});

test("ping frame from pwa → pong response", () => {
  const s = setup();
  try {
    const ws = mkFakeWs({ kind: "pwa", key: "pwa-1", user: "anonymous", user_id: "anonymous" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    s.server.websocket.message(ws as any, JSON.stringify({ type: "ping", ts: 999 }));
    expect(ws.sent).toHaveLength(1);
    const pong = JSON.parse(ws.sent[0] as string) as { type: string; ts: number };
    expect(pong.type).toBe("pong");
    expect(pong.ts).toBe(999);
  } finally { s.cleanup(); }
});

test("non-ping frame updates lastFrameAt and reaches router (no pong sent)", () => {
  const s = setup();
  try {
    const ws = mkFakeWs({ kind: "pwa", key: "pwa-1", user: "anonymous", user_id: "anonymous" });
    ws.data.lastFrameAt = 0;
    // `subscribe` is the simplest pwa frame that returns immediately; the
    // router handler iterates over no daemons → snapshot([]).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    s.server.websocket.message(ws as any, JSON.stringify({ type: "subscribe" }));
    // lastFrameAt was bumped (was 0)
    expect(ws.data.lastFrameAt).toBeGreaterThan(0);
    // No pong was sent (subscribe should produce a snapshot)
    const pongs = ws.sent.filter((p) => {
      try { return (JSON.parse(p) as { type?: string }).type === "pong"; } catch { return false; }
    });
    expect(pongs).toHaveLength(0);
  } finally { s.cleanup(); }
});

test("malformed json closes ws with code 1003 (regression: ping check must not crash on non-object)", () => {
  const s = setup();
  try {
    const ws = mkFakeWs({ kind: "daemon", key: "d1" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    s.server.websocket.message(ws as any, "{not json");
    expect(ws.closed?.code).toBe(1003);
  } finally { s.cleanup(); }
});

test("startHeartbeatWatchdog closes ws with stale lastFrameAt", async () => {
  const s = setup();
  try {
    // We can't easily inject ws into daemonReg from outside, so this test
    // exercises the watchdog by feeding the registries through `open`.
    // Use a tiny interval (10ms) and timeout (50ms) so the test runs fast.
    const stop = s.server.startHeartbeatWatchdog(10, 50);

    // We can stage a ws into daemonReg by calling `open` with a daemon-kind
    // ws. The registry will hold it; we backdate lastFrameAt and wait one
    // scan cycle.
    const ws = mkFakeWs({ kind: "daemon", key: "d1" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    s.server.websocket.open(ws as any);
    ws.data.lastFrameAt = Date.now() - 10_000;  // way past the 50ms cutoff

    // Wait two scan cycles (20-30ms) to ensure at least one runs.
    await new Promise((r) => setTimeout(r, 60));
    stop();

    expect(ws.closed?.code).toBe(1011);
    expect(ws.closed?.reason).toBe("heartbeat timeout");
  } finally { s.cleanup(); }
});

test("startHeartbeatWatchdog leaves fresh ws alone", async () => {
  const s = setup();
  try {
    const stop = s.server.startHeartbeatWatchdog(10, 1_000);
    const ws = mkFakeWs({ kind: "daemon", key: "d2" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    s.server.websocket.open(ws as any);
    // lastFrameAt is now-ish; cutoff is now - 1s
    await new Promise((r) => setTimeout(r, 30));
    stop();
    expect(ws.closed).toBeNull();
  } finally { s.cleanup(); }
});
