import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Router } from "../src/router.ts";
import { DaemonRegistry, PwaRegistry } from "../src/connections.ts";
import { openDb } from "../src/db.ts";
import { createDevice } from "../src/repos/devices.ts";
import { addPushSub } from "../src/repos/push-subs.ts";
import { pairDaemon } from "../src/repos/daemons.ts";

test("hello frame populates state and broadcasts daemon_online", () => {
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const broadcasts: unknown[] = [];
  const fakePwa = {} as object;
  preg.add(fakePwa, (f) => broadcasts.push(f));
  const router = new Router(dreg, preg);

  router.onDaemonFrame("d-1", {
    type: "hello",
    daemon_id: "d-1",
    epoch: 1,
    hostname: "macbook",
    agent_version: "0.1.0",
    sessions: [
      { session_id: "s1", tmux_session: "work", tmux_pane: "%0",
        cwd: "/x", model: "opus-4.7", pid: 1234, started_at: 1 }
    ]
  });

  expect(router.snapshot()).toEqual([
    { daemon_id: "d-1", hostname: "macbook", online: true,
      sessions: [{ session_id: "s1", tmux_session: "work", tmux_pane: "%0",
                   cwd: "/x", model: "opus-4.7", pid: 1234, started_at: 1 }]
    }
  ]);
  expect(broadcasts).toEqual([{
    type: "daemon_online", daemon_id: "d-1", hostname: "macbook",
    sessions: [{ session_id: "s1", tmux_session: "work", tmux_pane: "%0",
                 cwd: "/x", model: "opus-4.7", pid: 1234, started_at: 1 }]
  }]);
});

test("session_open broadcasts to PWAs", () => {
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const broadcasts: unknown[] = [];
  preg.add({}, (f) => broadcasts.push(f));
  const router = new Router(dreg, preg);

  router.onDaemonFrame("d-1", { type: "hello", daemon_id: "d-1", epoch: 1,
    hostname: "h", agent_version: "0", sessions: [] });
  broadcasts.length = 0;

  router.onDaemonFrame("d-1", {
    type: "session_open",
    session: { session_id: "s2", tmux_session: null, tmux_pane: null,
               cwd: "/y", model: "sonnet", pid: 99, started_at: 2 }
  });

  expect(broadcasts).toEqual([{
    type: "session_open",
    daemon_id: "d-1",
    session: { session_id: "s2", tmux_session: null, tmux_pane: null,
               cwd: "/y", model: "sonnet", pid: 99, started_at: 2 }
  }]);
});

test("daemon disconnect broadcasts daemon_offline and clears state", () => {
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const broadcasts: unknown[] = [];
  preg.add({}, (f) => broadcasts.push(f));
  const router = new Router(dreg, preg);

  router.onDaemonFrame("d-1", { type: "hello", daemon_id: "d-1", epoch: 1,
    hostname: "h", agent_version: "0", sessions: [] });
  broadcasts.length = 0;

  router.onDaemonDisconnect("d-1");
  expect(router.snapshot()).toEqual([]);
  expect(broadcasts).toEqual([{ type: "daemon_offline", daemon_id: "d-1" }]);
});

test("PWA subscribe receives current snapshot", () => {
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const router = new Router(dreg, preg);
  router.onDaemonFrame("d-1", { type: "hello", daemon_id: "d-1", epoch: 1,
    hostname: "h", agent_version: "0", sessions: [] });

  const sent: unknown[] = [];
  router.onPwaSubscribe((f) => sent.push(f));
  expect(sent).toEqual([{
    type: "snapshot",
    daemons: [{ daemon_id: "d-1", hostname: "h", online: true, sessions: [] }]
  }]);
});

test("event frame is broadcast to PWAs with daemon_id added", () => {
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const broadcasts: unknown[] = [];
  preg.add({}, (f) => broadcasts.push(f));
  const router = new Router(dreg, preg);

  router.onDaemonFrame("d-1", { type: "hello", daemon_id: "d-1", epoch: 1,
    hostname: "h", agent_version: "0", sessions: [] });
  broadcasts.length = 0;

  router.onDaemonFrame("d-1", {
    type: "event",
    session_id: "s1",
    jsonl_offset: 42,
    ts: 1000,
    payload: { type: "user", message: { content: "hi" } },
  });

  expect(broadcasts).toEqual([{
    type: "event",
    daemon_id: "d-1",
    session_id: "s1",
    jsonl_offset: 42,
    ts: 1000,
    payload: { type: "user", message: { content: "hi" } },
  }]);
});

test("ring buffer caps at 200", () => {
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const router = new Router(dreg, preg);
  router.onDaemonFrame("d-1", { type: "hello", daemon_id: "d-1", epoch: 1,
    hostname: "h", agent_version: "0", sessions: [] });
  for (let i = 0; i < 250; i++) {
    router.onDaemonFrame("d-1", {
      type: "event", session_id: "s1", jsonl_offset: i, ts: i, payload: { i },
    });
  }
  const buf = router.bufferOf("d-1");
  expect(buf.length).toBe(200);
  expect(buf[0]!.jsonl_offset).toBe(50);
  expect(buf[199]!.jsonl_offset).toBe(249);
});

test("permission_request frame fans out to PWAs with daemon_id", () => {
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const broadcasts: unknown[] = [];
  preg.add({}, (f) => broadcasts.push(f));
  const router = new Router(dreg, preg);

  router.onDaemonFrame("d-1", { type: "hello", daemon_id: "d-1", epoch: 1,
    hostname: "h", agent_version: "0", sessions: [] });
  broadcasts.length = 0;

  router.onDaemonFrame("d-1", {
    type: "permission_request",
    session_id: "s1",
    request_id: "r1",
    tool: "Bash",
    args_summary: "rm -rf /",
    expires_at: 9999,
  });
  expect(broadcasts).toEqual([{
    type: "permission_request",
    daemon_id: "d-1",
    session_id: "s1",
    request_id: "r1",
    tool: "Bash",
    args_summary: "rm -rf /",
    expires_at: 9999,
  }]);
});

test("permission_resolved frame fans out to PWAs with daemon_id", () => {
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const broadcasts: unknown[] = [];
  preg.add({}, (f) => broadcasts.push(f));
  const router = new Router(dreg, preg);

  router.onDaemonFrame("d-1", { type: "hello", daemon_id: "d-1", epoch: 1,
    hostname: "h", agent_version: "0", sessions: [] });
  broadcasts.length = 0;

  router.onDaemonFrame("d-1", {
    type: "permission_resolved",
    session_id: "s1",
    request_id: "r1",
    decision: "allow",
    decided_via: "pwa",
  });
  expect(broadcasts).toEqual([{
    type: "permission_resolved",
    daemon_id: "d-1",
    session_id: "s1",
    request_id: "r1",
    decision: "allow",
    decided_via: "pwa",
  }]);
});

test("onPwaCommand forwards permission_reply to addressed daemon", () => {
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const router = new Router(dreg, preg);

  const sentToDaemon: unknown[] = [];
  dreg.add("d-1", {}, (f) => sentToDaemon.push(f));

  router.onPwaCommand({
    type: "permission_reply",
    daemon_id: "d-1",
    session_id: "s1",
    request_id: "r1",
    decision: "allow",
  });

  expect(sentToDaemon).toEqual([{
    type: "permission_reply",
    session_id: "s1",
    request_id: "r1",
    decision: "allow",
  }]);
});

test("permission_request triggers Web Push fanout to subscriptions of daemon's owner", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-rp-"));
  try {
    const db = openDb(join(dir, "h.sqlite"));
    db.prepare("INSERT INTO users (sub, created_at) VALUES (?, ?)").run("u1", 1);
    pairDaemon(db, "d-1", "u1", "{}", null);
    const dev = createDevice(db, "u1", "iPhone", null, 60_000);
    addPushSub(db, dev.device_id, "https://fcm/x", "p", "a");

    const sentTo: Array<{ subs: unknown[]; payload: unknown }> = [];
    const push = {
      async sendTo(subs: unknown[], payload: unknown) {
        sentTo.push({ subs, payload });
      },
    };
    const dreg = new DaemonRegistry<unknown>();
    const preg = new PwaRegistry<unknown>();
    const router = new Router(dreg, preg, db, push);

    router.onDaemonFrame("d-1", { type: "hello", daemon_id: "d-1", epoch: 1,
      hostname: "h", agent_version: "0", sessions: [] });
    router.onDaemonFrame("d-1", {
      type: "permission_request",
      session_id: "s1",
      request_id: "r1",
      tool: "Bash",
      args_summary: "ls -la",
      expires_at: 9999,
    });

    await new Promise((r) => setTimeout(r, 10)); // let the void-promise dispatchPush complete

    expect(sentTo).toHaveLength(1);
    expect(sentTo[0]!.subs).toEqual([{ device_id: dev.device_id, endpoint: "https://fcm/x", p256dh: "p", auth: "a", preferences: { permission: true } }]);
    expect(sentTo[0]!.payload).toEqual({
      kind: "permission",
      daemon_id: "d-1", session_id: "s1", request_id: "r1",
      tool: "Bash", args_summary: "ls -la",
    });
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("permission_request with no push helper still works", () => {
  // Just verify existing tests / no exception when db/push undefined
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const router = new Router(dreg, preg);  // no db, no push
  router.onDaemonFrame("d-1", { type: "hello", daemon_id: "d-1", epoch: 1,
    hostname: "h", agent_version: "0", sessions: [] });
  router.onDaemonFrame("d-1", {
    type: "permission_request", session_id: "s1", request_id: "r1",
    tool: "Bash", args_summary: "x", expires_at: 9999,
  });
  // No throw → ok.
  expect(true).toBe(true);
});

test("history_chunk from daemon is broadcast to PWAs with daemon_id", () => {
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const broadcasts: unknown[] = [];
  preg.add({}, (f) => broadcasts.push(f));
  const router = new Router(dreg, preg);

  router.onDaemonFrame("d-1", { type: "hello", daemon_id: "d-1", epoch: 1,
    hostname: "h", agent_version: "0", sessions: [] });
  broadcasts.length = 0;

  router.onDaemonFrame("d-1", {
    type: "history_chunk",
    session_id: "s1",
    request_id: "rh1",
    events: [
      { jsonl_offset: 10, payload: { line: 1 } },
      { jsonl_offset: 22, payload: { line: 2 } },
    ],
  });
  expect(broadcasts).toEqual([{
    type: "history_chunk",
    daemon_id: "d-1",
    session_id: "s1",
    request_id: "rh1",
    events: [
      { jsonl_offset: 10, payload: { line: 1 } },
      { jsonl_offset: 22, payload: { line: 2 } },
    ],
  }]);
});

test("onPwaCommand forwards request_history to addressed daemon", () => {
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const router = new Router(dreg, preg);
  const sentToDaemon: unknown[] = [];
  dreg.add("d-1", {}, (f) => sentToDaemon.push(f));

  router.onPwaCommand({
    type: "request_history",
    daemon_id: "d-1",
    session_id: "s1",
    request_id: "rh1",
    before_offset: 9999,
    limit: 50,
  });
  expect(sentToDaemon).toEqual([{
    type: "request_history",
    session_id: "s1",
    request_id: "rh1",
    before_offset: 9999,
    limit: 50,
  }]);
});
