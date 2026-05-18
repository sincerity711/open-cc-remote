import { test, expect, beforeEach } from "bun:test";
import { DaemonRegistry, PwaRegistry } from "../src/connections.ts";

interface FakeWs { id: string; sent: unknown[] }
const mkWs = (id: string): FakeWs => ({ id, sent: [] });
const sender = (ws: FakeWs) => (frame: unknown) => { ws.sent.push(frame); };

test("DaemonRegistry add/remove/lookup", () => {
  const reg = new DaemonRegistry<FakeWs>();
  const ws = mkWs("c1");
  reg.add("daemon-a", ws, sender(ws));
  expect(reg.has("daemon-a")).toBe(true);
  expect(reg.list()).toEqual(["daemon-a"]);
  reg.remove("daemon-a");
  expect(reg.has("daemon-a")).toBe(false);
});

test("DaemonRegistry replaces existing connection on duplicate add", () => {
  const reg = new DaemonRegistry<FakeWs>();
  const ws1 = mkWs("c1");
  const ws2 = mkWs("c2");
  let ws1Closed = false;
  reg.add("d", ws1, sender(ws1), () => { ws1Closed = true; });
  reg.add("d", ws2, sender(ws2));
  expect(ws1Closed).toBe(true);
  expect(reg.list()).toEqual(["d"]);
});

test("PwaRegistry assigns unique ids and broadcasts", () => {
  const reg = new PwaRegistry<FakeWs>();
  const a = mkWs("a"); const b = mkWs("b");
  const idA = reg.add(a, sender(a));
  const idB = reg.add(b, sender(b));
  expect(idA).not.toBe(idB);
  reg.broadcast({ type: "snapshot", daemons: [] });
  expect(a.sent).toEqual([{ type: "snapshot", daemons: [] }]);
  expect(b.sent).toEqual([{ type: "snapshot", daemons: [] }]);
});
