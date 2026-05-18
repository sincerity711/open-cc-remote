import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { recordRequest, resolveRequest, getRequest } from "../src/repos/permissions.ts";

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), "ccr-pdb-"));
  const db = openDb(join(dir, "d.sqlite"));
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("recordRequest then getRequest returns the row", () => {
  const { db, cleanup } = tmpDb();
  try {
    recordRequest(db, "r1", "s1", "Bash", "rm -rf /");
    const row = getRequest(db, "r1");
    expect(row?.tool).toBe("Bash");
    expect(row?.args_summary).toBe("rm -rf /");
    expect(row?.session_id).toBe("s1");
    expect(row?.resolved_at).toBeNull();
  } finally { cleanup(); }
});

test("resolveRequest succeeds first time, fails second time (single-resolution)", () => {
  const { db, cleanup } = tmpDb();
  try {
    recordRequest(db, "r1", "s1", "Bash", "ls");
    expect(resolveRequest(db, "r1", "allow", "pwa")).toBe(true);
    expect(resolveRequest(db, "r1", "deny", "terminal")).toBe(false);
    const row = getRequest(db, "r1");
    expect(row?.decision).toBe("allow");
    expect(row?.decided_via).toBe("pwa");
    expect(row?.resolved_at).toBeTruthy();
  } finally { cleanup(); }
});

test("resolveRequest on unknown id returns false", () => {
  const { db, cleanup } = tmpDb();
  try {
    expect(resolveRequest(db, "ghost", "allow", "pwa")).toBe(false);
  } finally { cleanup(); }
});

test("recordRequest is idempotent for same request_id (does not overwrite)", () => {
  const { db, cleanup } = tmpDb();
  try {
    recordRequest(db, "r1", "s1", "Bash", "first");
    recordRequest(db, "r1", "s1", "Edit", "second");  // ignored
    const row = getRequest(db, "r1");
    expect(row?.tool).toBe("Bash");
    expect(row?.args_summary).toBe("first");
  } finally { cleanup(); }
});

test("getRequest returns null for unknown id", () => {
  const { db, cleanup } = tmpDb();
  try {
    expect(getRequest(db, "nope")).toBeNull();
  } finally { cleanup(); }
});
