import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { openDb } from "../src/db.ts";
import { MIGRATIONS } from "../src/schema.ts";

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), "ccr-mig3-"));
  const db = openDb(join(dir, "h.sqlite"));
  db.prepare("INSERT INTO users (sub, created_at) VALUES (?, ?)").run("u1", 1);
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function tmpDbAtV2() {
  const dir = mkdtempSync(join(tmpdir(), "ccr-mig3-pre-"));
  const dbPath = join(dir, "h.sqlite");
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(MIGRATIONS[0]!.sql);
  db.exec(MIGRATIONS[1]!.sql);
  // schema_migrations bookkeeping so a future openDb wouldn't double-apply
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (1, 1), (2, 1)").run();
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function applyV3(db: Database) {
  db.exec(MIGRATIONS[2]!.sql);
}

test("v3 creates topic_subscriptions table with composite PK including daemon_id", () => {
  const s = tmpDb();
  try {
    const cols = s.db.query("PRAGMA table_info(topic_subscriptions)").all() as Array<{ name: string; notnull: number; pk: number }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(["daemon_id", "device_id", "enabled", "topic_id"]);
    const pks = cols.filter((c) => c.pk > 0).map((c) => c.name).sort();
    expect(pks).toEqual(["daemon_id", "device_id", "topic_id"]);
  } finally { s.cleanup(); }
});

test("v3 creates dnd_settings table with device_id PK", () => {
  const s = tmpDb();
  try {
    const cols = s.db.query("PRAGMA table_info(dnd_settings)").all() as Array<{ name: string; pk: number }>;
    const pks = cols.filter((c) => c.pk > 0).map((c) => c.name);
    expect(pks).toEqual(["device_id"]);
  } finally { s.cleanup(); }
});

test("v3 backfills explicit preference keys for pre-existing push_subs rows", () => {
  const s = tmpDbAtV2();
  try {
    s.db.prepare("INSERT INTO users (sub, created_at) VALUES (?, ?)").run("u1", 1);
    s.db.prepare(
      "INSERT INTO devices (device_id, owner_sub, paired_at, token_hash, expires_at) VALUES (?, ?, ?, ?, ?)",
    ).run("dev1", "u1", 1, "tokhash", 9_999_999_999);
    s.db.prepare(
      "INSERT INTO push_subs (device_id, endpoint, p256dh, auth, preferences) VALUES (?, ?, ?, ?, ?)",
    ).run("dev1", "https://x", "p", "a", JSON.stringify({ permission: false, idle: true }));
    applyV3(s.db);
    const rows = s.db.query(
      "SELECT topic_id, enabled FROM topic_subscriptions WHERE device_id = ? AND daemon_id = '' ORDER BY topic_id",
    ).all("dev1") as Array<{ topic_id: string; enabled: number }>;
    expect(rows).toEqual([
      { topic_id: "idle",       enabled: 1 },
      { topic_id: "permission", enabled: 0 },
    ]);
  } finally { s.cleanup(); }
});

test("v3 does NOT copy missing preference keys (falls back to topic default at runtime)", () => {
  const s = tmpDbAtV2();
  try {
    s.db.prepare("INSERT INTO users (sub, created_at) VALUES (?, ?)").run("u1", 1);
    s.db.prepare(
      "INSERT INTO devices (device_id, owner_sub, paired_at, token_hash, expires_at) VALUES (?, ?, ?, ?, ?)",
    ).run("dev1", "u1", 1, "tokhash", 9_999_999_999);
    // Only permission key present
    s.db.prepare(
      "INSERT INTO push_subs (device_id, endpoint, p256dh, auth, preferences) VALUES (?, ?, ?, ?, ?)",
    ).run("dev1", "https://x", "p", "a", JSON.stringify({ permission: true }));
    applyV3(s.db);
    const ids = s.db.query(
      "SELECT topic_id FROM topic_subscriptions WHERE device_id = ?",
    ).all("dev1") as Array<{ topic_id: string }>;
    expect(ids.map((r) => r.topic_id).sort()).toEqual(["permission"]);
  } finally { s.cleanup(); }
});
