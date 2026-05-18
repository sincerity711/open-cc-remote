import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";

test("openDb creates all tables on first open", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-db-"));
  try {
    const db = openDb(join(dir, "test.sqlite"));
    const rows = db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>;
    const names = rows.map((r) => r.name);
    expect(names).toContain("users");
    expect(names).toContain("daemons");
    expect(names).toContain("devices");
    expect(names).toContain("pairing_codes");
    expect(names).toContain("schema_migrations");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("openDb is idempotent — re-opening does not re-apply migrations", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-db-"));
  const path = join(dir, "test.sqlite");
  try {
    const db1 = openDb(path);
    const before = db1.query("SELECT count(*) AS n FROM schema_migrations").get() as { n: number };
    db1.close();

    const db2 = openDb(path);
    const after = db2.query("SELECT count(*) AS n FROM schema_migrations").get() as { n: number };
    expect(after.n).toBe(before.n);
    expect(after.n).toBeGreaterThan(0);
    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("can insert into and select from users table", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-db-"));
  try {
    const db = openDb(join(dir, "test.sqlite"));
    db.prepare("INSERT INTO users (sub, email, created_at) VALUES (?, ?, ?)").run("u1", "u1@example.com", 1);
    const row = db.query("SELECT email FROM users WHERE sub = ?").get("u1") as { email: string };
    expect(row.email).toBe("u1@example.com");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
