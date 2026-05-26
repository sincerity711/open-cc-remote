import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { createDevice } from "../src/repos/devices.ts";
import { addPushSub } from "../src/repos/push-subs.ts";
import { pairDaemon } from "../src/repos/daemons.ts";
import {
  setSubscription, deleteSubscription, deleteAllForDaemon,
  findActiveSubsForTopic, listSubscriptions,
} from "../src/repos/topic-subscriptions.ts";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "ccr-tsub-"));
  const db = openDb(join(dir, "h.sqlite"));
  db.prepare("INSERT INTO users (sub, created_at) VALUES (?, ?)").run("u1", 1);
  const c = createDevice(db, "u1", "iPhone", null, 60_000);
  addPushSub(db, c.device_id, "https://x", "p", "a");
  pairDaemon(db, "d-1", "u1", "h", "{}", Date.now());
  return { db, device_id: c.device_id, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("findActiveSubsForTopic returns sub when topic.default_enabled=true and no rows", () => {
  const s = setup();
  try {
    const subs = findActiveSubsForTopic(s.db, "u1", "permission", "d-1", true);
    expect(subs).toHaveLength(1);
    expect(subs[0]!.device_id).toBe(s.device_id);
  } finally { s.cleanup(); }
});

test("findActiveSubsForTopic returns nothing when topic.default_enabled=false and no rows", () => {
  const s = setup();
  try {
    const subs = findActiveSubsForTopic(s.db, "u1", "idle", "d-1", false);
    expect(subs).toHaveLength(0);
  } finally { s.cleanup(); }
});

test("device-default row (daemon_id='') overrides topic.default_enabled", () => {
  const s = setup();
  try {
    setSubscription(s.db, s.device_id, "idle", "", true);
    expect(findActiveSubsForTopic(s.db, "u1", "idle", "d-1", false)).toHaveLength(1);
    setSubscription(s.db, s.device_id, "permission", "", false);
    expect(findActiveSubsForTopic(s.db, "u1", "permission", "d-1", true)).toHaveLength(0);
  } finally { s.cleanup(); }
});

test("daemon-specific row overrides device-default and topic-default", () => {
  const s = setup();
  try {
    setSubscription(s.db, s.device_id, "idle", "", true);
    setSubscription(s.db, s.device_id, "idle", "d-1", false);
    expect(findActiveSubsForTopic(s.db, "u1", "idle", "d-1", false)).toHaveLength(0);
    expect(findActiveSubsForTopic(s.db, "u1", "idle", "d-other", false)).toHaveLength(1);
  } finally { s.cleanup(); }
});

test("deleteSubscription reverts to lower fallback level", () => {
  const s = setup();
  try {
    setSubscription(s.db, s.device_id, "idle", "d-1", true);
    expect(findActiveSubsForTopic(s.db, "u1", "idle", "d-1", false)).toHaveLength(1);
    deleteSubscription(s.db, s.device_id, "idle", "d-1");
    expect(findActiveSubsForTopic(s.db, "u1", "idle", "d-1", false)).toHaveLength(0);
  } finally { s.cleanup(); }
});

test("deleteAllForDaemon removes only that daemon's overrides", () => {
  const s = setup();
  try {
    setSubscription(s.db, s.device_id, "permission", "d-1", false);
    setSubscription(s.db, s.device_id, "idle", "d-1", true);
    setSubscription(s.db, s.device_id, "completed", "", true);
    deleteAllForDaemon(s.db, s.device_id, "d-1");
    const rows = listSubscriptions(s.db, s.device_id);
    expect(rows).toEqual([{ topic_id: "completed", daemon_id: null, enabled: true }]);
  } finally { s.cleanup(); }
});

test("revoked devices are excluded from findActiveSubsForTopic", () => {
  const s = setup();
  try {
    s.db.prepare("UPDATE devices SET revoked_at = ? WHERE device_id = ?").run(Date.now(), s.device_id);
    expect(findActiveSubsForTopic(s.db, "u1", "permission", "d-1", true)).toHaveLength(0);
  } finally { s.cleanup(); }
});
