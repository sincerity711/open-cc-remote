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
import { setSubscription } from "../src/repos/topic-subscriptions.ts";
import { fixtureSession } from "../../proto/src/test-fixtures.ts";

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
      fixtureSession({ session_id: "s1", tmux_session: "work", tmux_pane: "%0", model: "opus-4.7", pid: 1234 })
    ]
  });

  expect(router.snapshot()).toEqual([
    { daemon_id: "d-1", hostname: "macbook", display_name: null, online: true,
      sessions: [fixtureSession({ session_id: "s1", tmux_session: "work", tmux_pane: "%0", model: "opus-4.7", pid: 1234 })]
    }
  ]);
  expect(broadcasts).toEqual([{
    type: "daemon_online", daemon_id: "d-1", hostname: "macbook", display_name: null,
    sessions: [fixtureSession({ session_id: "s1", tmux_session: "work", tmux_pane: "%0", model: "opus-4.7", pid: 1234 })]
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
    session: fixtureSession({ session_id: "s2", cwd: "/y", model: "sonnet", pid: 99, started_at: 2 }),
  });

  expect(broadcasts).toEqual([{
    type: "session_open",
    daemon_id: "d-1",
    session: fixtureSession({ session_id: "s2", cwd: "/y", model: "sonnet", pid: 99, started_at: 2 }),
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
    daemons: [{ daemon_id: "d-1", hostname: "h", display_name: null, online: true, sessions: [] }]
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
    payload: [],
  });

  expect(broadcasts).toHaveLength(1);
  const broadcast = broadcasts[0] as { type: string; daemon_id: string; session_id: string; jsonl_offset: number; payload: unknown[] };
  // The OTel layer may add an optional `trace` field when a tracer is
  // active; assert only the business fields, ignore observability metadata.
  expect(broadcast.type).toBe("event");
  expect(broadcast.daemon_id).toBe("d-1");
  expect(broadcast.session_id).toBe("s1");
  expect(broadcast.jsonl_offset).toBe(42);
  expect(broadcast.payload).toEqual([]);
});

test("ring buffer caps at 200", () => {
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const router = new Router(dreg, preg);
  router.onDaemonFrame("d-1", { type: "hello", daemon_id: "d-1", epoch: 1,
    hostname: "h", agent_version: "0", sessions: [] });
  for (let i = 0; i < 250; i++) {
    router.onDaemonFrame("d-1", {
      type: "event", session_id: "s1", jsonl_offset: i, payload: [],
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

test("ask_user_question_request frame fans out to PWAs with daemon_id", () => {
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const broadcasts: unknown[] = [];
  preg.add({}, (f) => broadcasts.push(f));
  const router = new Router(dreg, preg);

  router.onDaemonFrame("d-1", { type: "hello", daemon_id: "d-1", epoch: 1,
    hostname: "h", agent_version: "0", sessions: [] });
  broadcasts.length = 0;

  router.onDaemonFrame("d-1", {
    type: "ask_user_question_request",
    session_id: "s1",
    request_id: "ask-1",
    questions: [{
      question: "Where to put it?",
      header: "Location",
      multiSelect: false,
      options: [{ label: "docs/" }, { label: "src/" }],
    }],
    expires_at: 9999,
  });
  expect(broadcasts).toEqual([{
    type: "ask_user_question_request",
    daemon_id: "d-1",
    session_id: "s1",
    request_id: "ask-1",
    questions: [{
      question: "Where to put it?",
      header: "Location",
      multiSelect: false,
      options: [{ label: "docs/" }, { label: "src/" }],
    }],
    expires_at: 9999,
  }]);
});

test("ask_user_question_resolved frame fans out to PWAs", () => {
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const broadcasts: unknown[] = [];
  preg.add({}, (f) => broadcasts.push(f));
  const router = new Router(dreg, preg);
  router.onDaemonFrame("d-1", { type: "hello", daemon_id: "d-1", epoch: 1,
    hostname: "h", agent_version: "0", sessions: [] });
  broadcasts.length = 0;

  router.onDaemonFrame("d-1", {
    type: "ask_user_question_resolved",
    session_id: "s1",
    request_id: "ask-1",
    resolution: "answered",
  });
  expect(broadcasts).toEqual([{
    type: "ask_user_question_resolved",
    daemon_id: "d-1",
    session_id: "s1",
    request_id: "ask-1",
    resolution: "answered",
  }]);
});

test("PWA subscribe replays in-flight ask_user_question_requests", () => {
  // Refresh path: hook is still waiting on the daemon side; a freshly
  // connected PWA should re-render the picker without us asking the daemon
  // to re-emit. Resolved/expired questions must NOT replay.
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const router = new Router(dreg, preg);
  router.onDaemonFrame("d-1", { type: "hello", daemon_id: "d-1", epoch: 1,
    hostname: "h", agent_version: "0", sessions: [] });

  router.onDaemonFrame("d-1", {
    type: "ask_user_question_request", session_id: "s1", request_id: "ask-A",
    questions: [{ question: "first?", header: "Q", multiSelect: false, options: [] }],
    expires_at: 1_000,
  });
  router.onDaemonFrame("d-1", {
    type: "ask_user_question_request", session_id: "s1", request_id: "ask-B",
    questions: [{ question: "second?", header: "Q", multiSelect: false, options: [] }],
    expires_at: 2_000,
  });
  // ask-A is resolved before the new PWA connects → must not replay.
  router.onDaemonFrame("d-1", {
    type: "ask_user_question_resolved", session_id: "s1", request_id: "ask-A",
    resolution: "answered",
  });

  const sent: unknown[] = [];
  router.onPwaSubscribe((f) => sent.push(f));

  // First frame is the snapshot, then the lone in-flight question.
  expect((sent[0] as { type: string }).type).toBe("snapshot");
  const replays = sent.slice(1) as Array<{ type: string; request_id?: string }>;
  expect(replays.length).toBe(1);
  expect(replays[0].type).toBe("ask_user_question_request");
  expect(replays[0].request_id).toBe("ask-B");
});

test("onPwaCommand forwards ask_user_question_answer to addressed daemon", () => {
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const router = new Router(dreg, preg);
  const sentToDaemon: unknown[] = [];
  dreg.add("d-1", {}, (f) => sentToDaemon.push(f));

  router.onPwaCommand({
    type: "ask_user_question_answer",
    daemon_id: "d-1",
    session_id: "s1",
    request_id: "ask-1",
    answers: ["docs/", null],
  });

  expect(sentToDaemon).toEqual([{
    type: "ask_user_question_answer",
    session_id: "s1",
    request_id: "ask-1",
    answers: ["docs/", null],
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

    const sentTo: Array<{ subs: any; payload: any }> = [];
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
    expect(sentTo[0]!.subs.map((s: any) => s.device_id)).toEqual([dev.device_id]);
    expect(sentTo[0]!.payload.kind).toBe("permission");
    expect(sentTo[0]!.payload.daemon_id).toBe("d-1");
    expect(sentTo[0]!.payload.session_id).toBe("s1");
    expect(sentTo[0]!.payload.request_id).toBe("r1");
    expect(sentTo[0]!.payload.tag).toBe("permission:r1");
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
      { jsonl_offset: 10, payload: [] },
      { jsonl_offset: 22, payload: [] },
    ],
  });
  expect(broadcasts).toEqual([{
    type: "history_chunk",
    daemon_id: "d-1",
    session_id: "s1",
    request_id: "rh1",
    events: [
      { jsonl_offset: 10, payload: [] },
      { jsonl_offset: 22, payload: [] },
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

test("onPwaCommand forwards kill_session to addressed daemon", () => {
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const router = new Router(dreg, preg);
  const sentToDaemon: unknown[] = [];
  dreg.add("d-1", {}, (f) => sentToDaemon.push(f));

  router.onPwaCommand({
    type: "kill_session",
    daemon_id: "d-1",
    session_id: "s1",
  });
  expect(sentToDaemon).toEqual([{
    type: "kill_session",
    session_id: "s1",
  }]);
});

test("onPwaCommand forwards start_session to addressed daemon", () => {
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const router = new Router(dreg, preg);
  const sentToDaemon: unknown[] = [];
  dreg.add("d-1", {}, (f) => sentToDaemon.push(f));

  router.onPwaCommand({
    type: "start_session",
    daemon_id: "d-1",
    cwd: "/Users/me/work",
    name: "session-x",
  });
  expect(sentToDaemon).toEqual([{
    type: "start_session",
    cwd: "/Users/me/work",
    name: "session-x",
  }]);
});

test("onPwaCommand omits name when not provided in start_session", () => {
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const router = new Router(dreg, preg);
  const sentToDaemon: unknown[] = [];
  dreg.add("d-1", {}, (f) => sentToDaemon.push(f));

  router.onPwaCommand({
    type: "start_session",
    daemon_id: "d-1",
    cwd: "/Users/me/work",
  });
  expect(sentToDaemon).toEqual([{
    type: "start_session",
    cwd: "/Users/me/work",
  }]);
});

test("onPwaCommand forwards request_id when provided in start_session", () => {
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const router = new Router(dreg, preg);
  const sentToDaemon: unknown[] = [];
  dreg.add("d-1", {}, (f) => sentToDaemon.push(f));
  router.onPwaCommand({
    type: "start_session",
    daemon_id: "d-1",
    cwd: "/Users/me/work",
    request_id: "rs-7",
  });
  expect(sentToDaemon).toEqual([{
    type: "start_session",
    cwd: "/Users/me/work",
    request_id: "rs-7",
  }]);
});

test("start_session_rejected from daemon broadcasts to PWAs with daemon_id", () => {
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const broadcasts: unknown[] = [];
  preg.add({}, (f) => broadcasts.push(f));
  const router = new Router(dreg, preg);
  router.onDaemonFrame("d-1", {
    type: "hello", daemon_id: "d-1", epoch: 1, hostname: "h",
    agent_version: "0", sessions: [],
  });
  broadcasts.length = 0;
  router.onDaemonFrame("d-1", {
    type: "start_session_rejected",
    request_id: "rs-7",
    cwd: "/etc",
    reason: "cwd_not_allowed",
    message: "cwd /etc not in allowed_cwd_prefix",
  });
  expect(broadcasts).toEqual([{
    type: "start_session_rejected",
    daemon_id: "d-1",
    request_id: "rs-7",
    cwd: "/etc",
    reason: "cwd_not_allowed",
    message: "cwd /etc not in allowed_cwd_prefix",
  }]);
});

test("task_completed frame fans out to PWAs with daemon_id", () => {
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const broadcasts: unknown[] = [];
  preg.add({}, (f) => broadcasts.push(f));
  const router = new Router(dreg, preg);
  router.onDaemonFrame("d-1", { type: "hello", daemon_id: "d-1", epoch: 1,
    hostname: "h", agent_version: "0", sessions: [] });
  broadcasts.length = 0;
  router.onDaemonFrame("d-1", {
    type: "task_completed", session_id: "s1", ts: 12345,
  });
  expect(broadcasts).toEqual([{
    type: "task_completed", daemon_id: "d-1", session_id: "s1", ts: 12345,
  }]);
});

test("idle frame fans out to PWAs with daemon_id", () => {
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const broadcasts: unknown[] = [];
  preg.add({}, (f) => broadcasts.push(f));
  const router = new Router(dreg, preg);
  router.onDaemonFrame("d-1", { type: "hello", daemon_id: "d-1", epoch: 1,
    hostname: "h", agent_version: "0", sessions: [] });
  broadcasts.length = 0;
  router.onDaemonFrame("d-1", {
    type: "idle", session_id: "s1", ts: 9999,
  });
  expect(broadcasts).toEqual([{
    type: "idle", daemon_id: "d-1", session_id: "s1", ts: 9999,
  }]);
});

test("idle pushes to subs with prefs.idle === true", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-idl-"));
  try {
    const db = openDb(join(dir, "h.sqlite"));
    db.prepare("INSERT INTO users (sub, created_at) VALUES (?, ?)").run("u1", 1);
    pairDaemon(db, "d-1", "u1", "{}", null);
    const dev = createDevice(db, "u1", "iPhone", null, 60_000);
    addPushSub(db, dev.device_id, "https://x", "p", "a");
    setSubscription(db, dev.device_id, "idle", "", true);
    const sentTo: Array<{ payload: any }> = [];
    const push = { async sendTo(subs: unknown[], payload: any) { sentTo.push({ payload }); } };
    const dreg = new DaemonRegistry<unknown>();
    const preg = new PwaRegistry<unknown>();
    const router = new Router(dreg, preg, db, push);
    router.onDaemonFrame("d-1", { type: "hello", daemon_id: "d-1", epoch: 1,
      hostname: "h", agent_version: "0", sessions: [] });
    router.onDaemonFrame("d-1", { type: "idle", session_id: "s1", ts: 1 });
    await new Promise((r) => setTimeout(r, 30));
    expect(sentTo).toHaveLength(1);
    expect(sentTo[0]!.payload.kind).toBe("idle");
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("idle does not push when prefs.idle is not set", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-idn-"));
  try {
    const db = openDb(join(dir, "h.sqlite"));
    db.prepare("INSERT INTO users (sub, created_at) VALUES (?, ?)").run("u1", 1);
    pairDaemon(db, "d-1", "u1", "{}", null);
    const dev = createDevice(db, "u1", "iPhone", null, 60_000);
    addPushSub(db, dev.device_id, "https://x", "p", "a");
    const sentTo: unknown[] = [];
    const push = { async sendTo(subs: unknown[], payload: unknown) { sentTo.push({ payload }); } };
    const dreg = new DaemonRegistry<unknown>();
    const preg = new PwaRegistry<unknown>();
    const router = new Router(dreg, preg, db, push);
    router.onDaemonFrame("d-1", { type: "hello", daemon_id: "d-1", epoch: 1,
      hostname: "h", agent_version: "0", sessions: [] });
    router.onDaemonFrame("d-1", { type: "idle", session_id: "s1", ts: 1 });
    await new Promise((r) => setTimeout(r, 30));
    expect(sentTo).toHaveLength(0);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ─── chat routing ──────────────────────────────────────────────────────

test("onPwaChatSend forwards to daemon with message_id, user, ts populated", () => {
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const router = new Router(dreg, preg);
  const sentToDaemon: any[] = [];
  dreg.add("d-1", {}, (f) => sentToDaemon.push(f));

  const senderSent: unknown[] = [];
  router.onPwaChatSend(
    { type: "chat_send", daemon_id: "d-1", session_id: "s1", content: "hi" },
    { user: "alice@example.com", user_id: "sub-123" },
    (f) => senderSent.push(f),
  );

  expect(sentToDaemon).toHaveLength(1);
  const out = sentToDaemon[0]!;
  expect(out.type).toBe("chat_send");
  expect(out.session_id).toBe("s1");
  expect(out.user).toBe("alice@example.com");
  expect(out.user_id).toBe("sub-123");
  expect(out.content).toBe("hi");
  expect(out.reply_to).toBeNull();
  expect(typeof out.message_id).toBe("string");
  expect(out.message_id.length).toBeGreaterThan(0);
  expect(typeof out.ts).toBe("number");
});

test("onPwaChatSend broadcasts echo to all PWA subscribers with from=pwa", () => {
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const router = new Router(dreg, preg);
  dreg.add("d-1", {}, () => {});

  const a: any[] = [];
  const b: any[] = [];
  preg.add({}, (f) => a.push(f));
  preg.add({}, (f) => b.push(f));

  router.onPwaChatSend(
    { type: "chat_send", daemon_id: "d-1", session_id: "s1", content: "hello" },
    { user: "alice@example.com", user_id: "sub-123" },
    () => {},
  );

  // Both PWAs (sender + other tab) get the echo.
  const aChat = a.find((f) => f.type === "chat");
  const bChat = b.find((f) => f.type === "chat");
  expect(aChat).toBeDefined();
  expect(bChat).toBeDefined();
  expect(aChat.from).toBe("pwa");
  expect(aChat.user).toBe("alice@example.com");
  expect(aChat.daemon_id).toBe("d-1");
  expect(aChat.session_id).toBe("s1");
  expect(aChat.content).toBe("hello");
  expect(aChat.message_id).toBe(bChat.message_id);  // same message_id across tabs
});

test("daemon chat_out broadcasts to all PWA subscribers with from=claude and fresh message_id", () => {
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const broadcasts: any[] = [];
  preg.add({}, (f) => broadcasts.push(f));
  const router = new Router(dreg, preg);

  router.onDaemonFrame("d-1", { type: "hello", daemon_id: "d-1", epoch: 1,
    hostname: "h", agent_version: "0", sessions: [] });
  broadcasts.length = 0;

  router.onDaemonFrame("d-1", {
    type: "chat_out",
    session_id: "s1",
    content: "ack from claude",
    ts: 1716000020,
    reply_to: "m_prev",
  });

  expect(broadcasts).toHaveLength(1);
  const f = broadcasts[0]!;
  expect(f.type).toBe("chat");
  expect(f.daemon_id).toBe("d-1");
  expect(f.session_id).toBe("s1");
  expect(f.from).toBe("claude");
  expect(f.user).toBeNull();
  expect(f.content).toBe("ack from claude");
  expect(f.reply_to).toBe("m_prev");
  expect(f.ts).toBe(1716000020);
  expect(typeof f.message_id).toBe("string");
  expect(f.message_id.length).toBeGreaterThan(0);
});

test("onPwaChatSend to offline daemon returns chat_error to sender only, no broadcast", () => {
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const router = new Router(dreg, preg);

  const otherTab: any[] = [];
  preg.add({}, (f) => otherTab.push(f));

  const senderSent: any[] = [];
  router.onPwaChatSend(
    { type: "chat_send", daemon_id: "d-offline", session_id: "s1", content: "hi" },
    { user: "alice@example.com", user_id: "sub-123" },
    (f) => senderSent.push(f),
  );

  expect(senderSent).toHaveLength(1);
  expect(senderSent[0]).toEqual({
    type: "chat_error",
    daemon_id: "d-offline",
    session_id: "s1",
    reason: "daemon_offline",
  });
  // No broadcast to other tabs (no daemon → no echo either).
  expect(otherTab.find((f) => f.type === "chat")).toBeUndefined();
});

test("onPwaChatSend echoes client_message_id on the chat broadcast", () => {
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const router = new Router(dreg, preg);
  dreg.add("d", {}, () => {});

  const broadcasts: any[] = [];
  preg.add({}, (f) => broadcasts.push(f));

  router.onPwaChatSend(
    { type: "chat_send", daemon_id: "d", session_id: "s", content: "hi", client_message_id: "cm-1" },
    { user: "alice@example", user_id: "u1" },
    () => {},
  );

  const chatFrame = broadcasts.find((f) => f.type === "chat");
  expect(chatFrame).toBeDefined();
  expect(chatFrame.client_message_id).toBe("cm-1");
});

test("onPwaChatSend echoes client_message_id on chat_error when daemon offline", () => {
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const router = new Router(dreg, preg);

  let capturedErr: any = undefined;
  router.onPwaChatSend(
    { type: "chat_send", daemon_id: "missing", session_id: "s", content: "hi", client_message_id: "cm-2" },
    { user: "alice", user_id: "u1" },
    (f) => { capturedErr = f; },
  );

  expect(capturedErr).toBeDefined();
  expect(capturedErr.type).toBe("chat_error");
  expect(capturedErr.client_message_id).toBe("cm-2");
});

test("onPwaChatSend preserves reply_to when provided", () => {
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const router = new Router(dreg, preg);
  const sentToDaemon: any[] = [];
  dreg.add("d-1", {}, (f) => sentToDaemon.push(f));

  router.onPwaChatSend(
    { type: "chat_send", daemon_id: "d-1", session_id: "s1", content: "re: hi", reply_to: "m_prior" },
    { user: "alice@example.com", user_id: "sub-123" },
    () => {},
  );

  expect(sentToDaemon[0]!.reply_to).toBe("m_prior");
});

test("getConnectedDaemonIds returns currently-connected daemon ids", () => {
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const router = new Router(dreg, preg);

  expect([...router.getConnectedDaemonIds()]).toEqual([]);

  router.onDaemonFrame("d1", { type: "hello", hostname: "h1", epoch: 1, daemon_id: "d1", agent_version: "0", sessions: [] } as any);
  router.onDaemonFrame("d2", { type: "hello", hostname: "h2", epoch: 1, daemon_id: "d2", agent_version: "0", sessions: [] } as any);
  expect(new Set(router.getConnectedDaemonIds())).toEqual(new Set(["d1", "d2"]));

  router.onDaemonDisconnect("d1");
  expect([...router.getConnectedDaemonIds()]).toEqual(["d2"]);
});

test("closeDaemonConnection closes the underlying ws when registered + connected", () => {
  const dreg = new DaemonRegistry<{ close: (code?: number, reason?: string) => void }>();
  const preg = new PwaRegistry<unknown>();
  const router = new Router(dreg, preg);

  let closed = false;
  const wsStub = { close: () => { closed = true; } };
  dreg.add("d1", wsStub, () => {}, undefined);
  router.onDaemonFrame("d1", { type: "hello", hostname: "h1", epoch: 1, daemon_id: "d1", agent_version: "0", sessions: [] } as any);

  router.closeDaemonConnection("d1");
  expect(closed).toBe(true);
});

test("closeDaemonConnection of unknown daemon is a no-op", () => {
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const router = new Router(dreg, preg);
  expect(() => router.closeDaemonConnection("nope")).not.toThrow();
});

test("session_open forwards request_id from daemon to PWA", () => {
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const broadcasts: unknown[] = [];
  preg.add({}, (f) => broadcasts.push(f));
  const router = new Router(dreg, preg);

  router.onDaemonFrame("d", { type: "hello", daemon_id: "d", epoch: 1, hostname: "h", agent_version: "v", sessions: [] });
  broadcasts.length = 0;

  router.onDaemonFrame("d", {
    type: "session_open",
    session: fixtureSession({ session_id: "s-req", cwd: "/z", model: "sonnet", pid: 42, started_at: 3 }),
    request_id: "req-7",
  });

  expect(broadcasts).toHaveLength(1);
  const frame = broadcasts[0] as any;
  expect(frame.type).toBe("session_open");
  expect(frame.daemon_id).toBe("d");
  expect(frame.request_id).toBe("req-7");
});

// ─── slash_inventory + cli_command ────────────────────────────────────

test("daemon slash_inventory is broadcast to PWAs with daemon_id added", () => {
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const broadcasts: unknown[] = [];
  preg.add({}, (f) => broadcasts.push(f));
  const router = new Router(dreg, preg);

  router.onDaemonFrame("d-1", {
    type: "hello", daemon_id: "d-1", epoch: 1,
    hostname: "h", agent_version: "0", sessions: [],
  });
  router.onDaemonFrame("d-1", {
    type: "slash_inventory",
    session_id: "s1",
    entries: [
      { id: "builtin:clear", name: "/clear", source: "builtin" },
      { id: "skill:brainstorming", name: "/brainstorming", source: "skill" },
    ],
  });

  const inv = broadcasts.find((b: any) => b.type === "slash_inventory") as any;
  expect(inv).toBeDefined();
  expect(inv.daemon_id).toBe("d-1");
  expect(inv.session_id).toBe("s1");
  expect(inv.entries).toHaveLength(2);
});

// ─── agent_handshake (Task #3 AionUi-borrow) ──────────────────────────

const SAMPLE_HANDSHAKE_BODY = {
  agent_version: "2.1.165",
  available_modes: ["acceptEdits", "default"],
  default_mode: "default",
  available_models: ["sonnet", "opus", "haiku"],
  available_commands: [],
  capabilities: {
    supports_notification_hook: true,
    supports_ack: true,
    jsonl_flush_quirk: true,
    has_mcp: true,
    has_plugin: true,
  },
};

test("daemon agent_handshake is broadcast to PWAs with daemon_id added", () => {
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const broadcasts: unknown[] = [];
  preg.add({}, (f) => broadcasts.push(f));
  const router = new Router(dreg, preg);

  router.onDaemonFrame("d-1", {
    type: "hello", daemon_id: "d-1", epoch: 1,
    hostname: "h", agent_version: "0", sessions: [],
  });
  router.onDaemonFrame("d-1", {
    type: "agent_handshake",
    session_id: "s1",
    ...SAMPLE_HANDSHAKE_BODY,
  });

  const h = broadcasts.find((b: any) => b.type === "agent_handshake") as any;
  expect(h).toBeDefined();
  expect(h.daemon_id).toBe("d-1");
  expect(h.session_id).toBe("s1");
  expect(h.agent_version).toBe("2.1.165");
  expect(h.default_mode).toBe("default");
  expect(h.capabilities.supports_ack).toBe(true);
});

test("agent_handshake is replayed on onPwaSubscribe", () => {
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const router = new Router(dreg, preg);

  router.onDaemonFrame("d-1", {
    type: "hello", daemon_id: "d-1", epoch: 1,
    hostname: "h", agent_version: "0", sessions: [],
  });
  router.onDaemonFrame("d-1", {
    type: "agent_handshake",
    session_id: "s1",
    ...SAMPLE_HANDSHAKE_BODY,
  });

  // A fresh PWA subscribes after the handshake was already routed.
  const replay: unknown[] = [];
  router.onPwaSubscribe((f) => replay.push(f));

  const h = replay.find((f: any) => f.type === "agent_handshake") as any;
  expect(h).toBeDefined();
  expect(h.daemon_id).toBe("d-1");
  expect(h.session_id).toBe("s1");
  expect(h.agent_version).toBe("2.1.165");
});

test("agent_handshake is cleared on session_close", () => {
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const router = new Router(dreg, preg);

  router.onDaemonFrame("d-1", {
    type: "hello", daemon_id: "d-1", epoch: 1,
    hostname: "h", agent_version: "0", sessions: [],
  });
  router.onDaemonFrame("d-1", {
    type: "agent_handshake",
    session_id: "s1",
    ...SAMPLE_HANDSHAKE_BODY,
  });
  router.onDaemonFrame("d-1", {
    type: "session_close",
    session_id: "s1",
    reason: "plugin_bye",
  });

  const replay: unknown[] = [];
  router.onPwaSubscribe((f) => replay.push(f));
  const h = replay.find((f: any) => f.type === "agent_handshake");
  expect(h).toBeUndefined();
});

test("onPwaCliCommand forwards to the addressed daemon with user attached", () => {
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const router = new Router(dreg, preg);

  const sentToDaemon: unknown[] = [];
  dreg.add("d-1", {}, (f) => sentToDaemon.push(f));

  router.onPwaCliCommand(
    { type: "cli_command", daemon_id: "d-1", session_id: "s1", text: "/clear" },
    { user: "alice@x", user_id: "alice" },
  );

  expect(sentToDaemon).toEqual([{
    type: "cli_command",
    session_id: "s1",
    text: "/clear",
    user: "alice@x",
  }]);
});

test("onPwaCliCommand for unknown daemon is silently dropped", () => {
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const router = new Router(dreg, preg);

  expect(() =>
    router.onPwaCliCommand(
      { type: "cli_command", daemon_id: "missing", session_id: "s1", text: "/clear" },
      { user: "alice@x", user_id: "alice" },
    ),
  ).not.toThrow();
});

// ─── fs_list routing ───────────────────────────────────────────────────

test("onPwaFsList forwards to online daemon as HubToDaemonFsList — daemon_id stripped, request_id and trace preserved", () => {
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const router = new Router(dreg, preg);

  const sentToDaemon: unknown[] = [];
  dreg.add("d-1", {}, (f) => sentToDaemon.push(f));

  // PWA must be registered so we have a real pwa_id to pin the request to.
  const senderSent: unknown[] = [];
  const pwa_id = preg.add({}, (f) => senderSent.push(f));

  const trace = { traceparent: "00-aaa-bbb-01" };
  router.onPwaFsList(
    { type: "fs_list", daemon_id: "d-1", request_id: "r-1", path: "~/proj", trace },
    pwa_id,
    (f) => senderSent.push(f),
  );

  expect(sentToDaemon).toEqual([{
    type: "fs_list",
    request_id: "r-1",
    path: "~/proj",
    trace: { traceparent: "00-aaa-bbb-01" },
  }]);
  // No reply yet, sender must not have received anything.
  expect(senderSent).toEqual([]);
});

test("onPwaFsList for offline daemon replies directly to originating PWA with error: io", () => {
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const router = new Router(dreg, preg);

  // No daemon added. Other PWAs should NOT see this reply.
  const otherPwaSent: unknown[] = [];
  preg.add({}, (f) => otherPwaSent.push(f));

  const senderSent: unknown[] = [];
  const pwa_id = preg.add({}, (f) => senderSent.push(f));

  router.onPwaFsList(
    { type: "fs_list", daemon_id: "d-missing", request_id: "r-2", path: "/x" },
    pwa_id,
    (f) => senderSent.push(f),
  );

  expect(senderSent).toEqual([{
    type: "fs_list_result",
    daemon_id: "d-missing",
    request_id: "r-2",
    ok: false,
    error: "io",
  }]);
  expect(otherPwaSent).toEqual([]);
});

test("daemon fs_list_result is routed back to the originating PWA only — request_id correlated, daemon_id filled in", () => {
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const router = new Router(dreg, preg);

  router.onDaemonFrame("d-1", { type: "hello", daemon_id: "d-1", epoch: 1,
    hostname: "h", agent_version: "0", sessions: [] });

  const sentToDaemon: unknown[] = [];
  dreg.add("d-1", {}, (f) => sentToDaemon.push(f));

  // Two PWAs; only the one that sent the request must see the reply.
  const otherPwaSent: unknown[] = [];
  preg.add({}, (f) => otherPwaSent.push(f));

  const senderSent: unknown[] = [];
  const sender_pwa_id = preg.add({}, (f) => senderSent.push(f));

  router.onPwaFsList(
    { type: "fs_list", daemon_id: "d-1", request_id: "r-3", path: "/home/me" },
    sender_pwa_id,
    (f) => senderSent.push(f),
  );

  // Daemon answers.
  router.onDaemonFrame("d-1", {
    type: "fs_list_result",
    request_id: "r-3",
    ok: true,
    path: "/home/me",
    entries: [
      { name: "src", is_dir: true },
      { name: "README.md", is_dir: false },
    ],
  });

  expect(senderSent).toEqual([{
    type: "fs_list_result",
    daemon_id: "d-1",
    request_id: "r-3",
    ok: true,
    path: "/home/me",
    entries: [
      { name: "src", is_dir: true },
      { name: "README.md", is_dir: false },
    ],
  }]);
  // The other PWA (not the originator) must not have received a copy.
  expect(otherPwaSent).toEqual([]);
});

test("fs_list_result whose originating PWA disconnected before the reply is dropped without crashing", () => {
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const router = new Router(dreg, preg);

  router.onDaemonFrame("d-1", { type: "hello", daemon_id: "d-1", epoch: 1,
    hostname: "h", agent_version: "0", sessions: [] });

  const sentToDaemon: unknown[] = [];
  dreg.add("d-1", {}, (f) => sentToDaemon.push(f));

  const senderSent: unknown[] = [];
  const sender_pwa_id = preg.add({}, (f) => senderSent.push(f));
  router.onPwaFsList(
    { type: "fs_list", daemon_id: "d-1", request_id: "r-4", path: "/x" },
    sender_pwa_id,
    (f) => senderSent.push(f),
  );

  // Originating PWA disconnects — routes.ts notifies the router so
  // pendingFsList is pruned. After that, even if a reply arrives, no
  // delivery attempt is made and nothing throws.
  preg.remove(sender_pwa_id);
  router.onPwaDisconnect(sender_pwa_id);

  expect(() =>
    router.onDaemonFrame("d-1", {
      type: "fs_list_result",
      request_id: "r-4",
      ok: true,
      path: "/x",
      entries: [],
    }),
  ).not.toThrow();
  expect(senderSent).toEqual([]); // no reply sneaks through
});
