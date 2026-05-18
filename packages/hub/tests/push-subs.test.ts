import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { createDevice } from "../src/repos/devices.ts";
import { addPushSub, removePushSub, findSubsByOwner } from "../src/repos/push-subs.ts";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "ccr-ps-"));
  const db = openDb(join(dir, "h.sqlite"));
  db.prepare("INSERT INTO users (sub, created_at) VALUES (?, ?)").run("u1", 1);
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("addPushSub and findSubsByOwner round-trip", () => {
  const s = setup();
  try {
    const c = createDevice(s.db, "u1", "iPhone", null, 60_000);
    addPushSub(s.db, c.device_id, "https://fcm/x", "p256dh-key", "auth-key");
    const subs = findSubsByOwner(s.db, "u1");
    expect(subs).toHaveLength(1);
    expect(subs[0]!.endpoint).toBe("https://fcm/x");
    expect(subs[0]!.p256dh).toBe("p256dh-key");
    expect(subs[0]!.auth).toBe("auth-key");
    expect(subs[0]!.device_id).toBe(c.device_id);
  } finally { s.cleanup(); }
});

test("addPushSub upsert: same device_id replaces existing subscription", () => {
  const s = setup();
  try {
    const c = createDevice(s.db, "u1", "iPhone", null, 60_000);
    addPushSub(s.db, c.device_id, "https://old/x", "p1", "a1");
    addPushSub(s.db, c.device_id, "https://new/x", "p2", "a2");
    const subs = findSubsByOwner(s.db, "u1");
    expect(subs).toHaveLength(1);
    expect(subs[0]!.endpoint).toBe("https://new/x");
  } finally { s.cleanup(); }
});

test("removePushSub deletes the entry", () => {
  const s = setup();
  try {
    const c = createDevice(s.db, "u1", "iPhone", null, 60_000);
    addPushSub(s.db, c.device_id, "https://fcm/x", "p", "a");
    expect(findSubsByOwner(s.db, "u1")).toHaveLength(1);
    removePushSub(s.db, c.device_id);
    expect(findSubsByOwner(s.db, "u1")).toHaveLength(0);
  } finally { s.cleanup(); }
});

test("findSubsByOwner skips revoked devices", () => {
  const s = setup();
  try {
    const c1 = createDevice(s.db, "u1", "iPhone", null, 60_000);
    const c2 = createDevice(s.db, "u1", "Mac", null, 60_000);
    addPushSub(s.db, c1.device_id, "https://a", "p", "a");
    addPushSub(s.db, c2.device_id, "https://b", "p", "a");
    s.db.prepare("UPDATE devices SET revoked_at = ? WHERE device_id = ?").run(1, c1.device_id);
    const subs = findSubsByOwner(s.db, "u1");
    expect(subs).toHaveLength(1);
    expect(subs[0]!.endpoint).toBe("https://b");
  } finally { s.cleanup(); }
});
