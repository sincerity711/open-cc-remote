import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { issueCode, MAX_PAIR_TTL_MS } from "../src/repos/pairing-codes.ts";

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), "ccr-codes-"));
  const db = openDb(join(dir, "h.sqlite"));
  db.prepare("INSERT INTO users (sub, created_at) VALUES (?, ?)").run("u1", 1);
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("issueCode is 8 chars across the alphabet", () => {
  const { db, cleanup } = tmpDb();
  try {
    for (let i = 0; i < 50; i++) {
      const code = issueCode(db, "daemon", "u1", null, 60_000);
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    }
  } finally { cleanup(); }
});

test("issueCode does not call Math.random", () => {
  // Replace Math.random with a sentinel that throws if invoked. Any regression
  // back to the old generator immediately fails this test.
  const orig = Math.random;
  Math.random = () => { throw new Error("Math.random must not be used for pair codes"); };
  try {
    const { db, cleanup } = tmpDb();
    try {
      for (let i = 0; i < 5; i++) issueCode(db, "daemon", "u1", null, 60_000);
    } finally { cleanup(); }
  } finally { Math.random = orig; }
});

test("issueCode clamps long ttlMs to MAX_PAIR_TTL_MS", () => {
  const { db, cleanup } = tmpDb();
  try {
    const before = Date.now();
    const code = issueCode(db, "daemon", "u1", null, 24 * 3600 * 1000);
    const row = db.query("SELECT expires_at FROM pairing_codes WHERE code = ?")
      .get(code) as { expires_at: number };
    // Should be within MAX_PAIR_TTL_MS, not 24h.
    const headroom = 5_000;
    expect(row.expires_at).toBeLessThanOrEqual(before + MAX_PAIR_TTL_MS + headroom);
    expect(row.expires_at).toBeGreaterThan(before + MAX_PAIR_TTL_MS - headroom);
  } finally { cleanup(); }
});
