import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { createDevice } from "../src/repos/devices.ts";
import { addPushSub } from "../src/repos/push-subs.ts";
import { pairDaemon } from "../src/repos/daemons.ts";
import { setSubscription } from "../src/repos/topic-subscriptions.ts";
import { setDndSettings } from "../src/repos/dnd.ts";
import { dispatchTopic } from "../src/push-dispatch.ts";
import { getTopic } from "../src/push-topics.ts";
import type { PushHelper } from "../src/push.ts";
import type { PushSubRow } from "../src/repos/push-subs.ts";

function fakePush(): PushHelper & { calls: Array<{ subs: string[]; payload: object }> } {
  const calls: Array<{ subs: string[]; payload: object }> = [];
  return {
    calls,
    async sendTo(subs: PushSubRow[], payload: object) {
      calls.push({ subs: subs.map((s) => s.device_id), payload });
    },
  } as PushHelper & { calls: Array<{ subs: string[]; payload: object }> };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "ccr-disp-"));
  const db = openDb(join(dir, "h.sqlite"));
  db.prepare("INSERT INTO users (sub, created_at) VALUES (?, ?)").run("u1", 1);
  const c = createDevice(db, "u1", "iPhone", null, 60_000);
  addPushSub(db, c.device_id, "https://x", "p", "a");
  pairDaemon(db, "d-1", "u1", "{}", "h");
  return { db, device_id: c.device_id, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("permission topic dispatches by default (default_enabled=true)", async () => {
  const s = setup();
  const push = fakePush();
  try {
    await dispatchTopic(s.db, push, getTopic("permission"), "d-1", {
      daemon_id: "d-1", session_id: "sess", request_id: "r1", tool: "Bash", args_summary: "ls",
    });
    expect(push.calls).toHaveLength(1);
    expect(push.calls[0]!.subs).toEqual([s.device_id]);
  } finally { s.cleanup(); }
});

test("idle topic does NOT dispatch by default", async () => {
  const s = setup();
  const push = fakePush();
  try {
    await dispatchTopic(s.db, push, getTopic("idle"), "d-1", { daemon_id: "d-1", session_id: "s1" });
    expect(push.calls).toHaveLength(0);
  } finally { s.cleanup(); }
});

test("idle dispatches once enabled at device level", async () => {
  const s = setup();
  const push = fakePush();
  try {
    setSubscription(s.db, s.device_id, "idle", "", true);
    await dispatchTopic(s.db, push, getTopic("idle"), "d-1", { daemon_id: "d-1", session_id: "s1" });
    expect(push.calls).toHaveLength(1);
  } finally { s.cleanup(); }
});

test("non-bypass topic suppressed during DND window", async () => {
  const s = setup();
  const push = fakePush();
  try {
    setSubscription(s.db, s.device_id, "idle", "", true);
    const now = new Date();
    const hh = String(now.getUTCHours()).padStart(2, "0");
    const endHh = String((now.getUTCHours() + 1) % 24).padStart(2, "0");
    setDndSettings(s.db, s.device_id, { enabled: true, start_hh_mm: `${hh}:00`, end_hh_mm: `${endHh}:00`, timezone: "UTC" });
    await dispatchTopic(s.db, push, getTopic("idle"), "d-1", { daemon_id: "d-1", session_id: "s1" });
    expect(push.calls).toHaveLength(0);
  } finally { s.cleanup(); }
});

test("bypass_dnd topic delivered during DND window", async () => {
  const s = setup();
  const push = fakePush();
  try {
    const now = new Date();
    const hh = String(now.getUTCHours()).padStart(2, "0");
    const endHh = String((now.getUTCHours() + 1) % 24).padStart(2, "0");
    setDndSettings(s.db, s.device_id, { enabled: true, start_hh_mm: `${hh}:00`, end_hh_mm: `${endHh}:00`, timezone: "UTC" });
    await dispatchTopic(s.db, push, getTopic("permission"), "d-1", {
      daemon_id: "d-1", session_id: "s", request_id: "r", tool: "B", args_summary: "x",
    });
    expect(push.calls).toHaveLength(1);
  } finally { s.cleanup(); }
});

test("dispatch is no-op for unknown daemon", async () => {
  const s = setup();
  const push = fakePush();
  try {
    await dispatchTopic(s.db, push, getTopic("permission"), "d-unknown", { daemon_id: "d-unknown" });
    expect(push.calls).toHaveLength(0);
  } finally { s.cleanup(); }
});

test("payload includes tag from topic.build_tag", async () => {
  const s = setup();
  const push = fakePush();
  try {
    await dispatchTopic(s.db, push, getTopic("permission"), "d-1", {
      daemon_id: "d-1", session_id: "s", request_id: "r-x", tool: "B", args_summary: "x",
    });
    const p = push.calls[0]!.payload as { tag?: string };
    expect(typeof p.tag).toBe("string");
  } finally { s.cleanup(); }
});
