import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { createDevice } from "../src/repos/devices.ts";
import { extractBearer, authenticatePwa } from "../src/auth/pwa-auth.ts";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "ccr-pwa-"));
  const db = openDb(join(dir, "h.sqlite"));
  db.prepare("INSERT INTO users (sub, created_at) VALUES (?, ?)").run("u1", 1);
  return { db, dir, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("extractBearer reads Authorization: Bearer", () => {
  const req = new Request("http://h/x", { headers: { authorization: "Bearer abc" } });
  expect(extractBearer(req)).toBe("abc");
});

test("extractBearer reads cc_session cookie", () => {
  const req = new Request("http://h/x", { headers: { cookie: "other=1; cc_session=tok123; foo=bar" } });
  expect(extractBearer(req)).toBe("tok123");
});

test("extractBearer reads ?bearer= query fallback", () => {
  const req = new Request("http://h/x?bearer=qval");
  expect(extractBearer(req)).toBe("qval");
});

test("extractBearer returns null when nothing present", () => {
  expect(extractBearer(new Request("http://h/x"))).toBeNull();
});

test("authenticatePwa with valid bearer succeeds", () => {
  const s = setup();
  try {
    const c = createDevice(s.db, "u1", "iPhone", null, 60_000);
    const req = new Request("http://h/x", { headers: { authorization: `Bearer ${c.bearer}` } });
    const r = authenticatePwa(s.db, req) as { device_id: string };
    expect(r.device_id).toBe(c.device_id);
  } finally { s.cleanup(); }
});

test("authenticatePwa with missing bearer fails", () => {
  const s = setup();
  try {
    const r = authenticatePwa(s.db, new Request("http://h/x"));
    expect((r as { error: string }).error).toMatch(/required/);
  } finally { s.cleanup(); }
});

test("authenticatePwa with revoked token fails", () => {
  const s = setup();
  try {
    const c = createDevice(s.db, "u1", "iPhone", null, 60_000);
    s.db.prepare("UPDATE devices SET revoked_at = ? WHERE device_id = ?").run(1, c.device_id);
    const req = new Request("http://h/x", { headers: { authorization: `Bearer ${c.bearer}` } });
    expect((authenticatePwa(s.db, req) as { error: string }).error).toMatch(/revoked/);
  } finally { s.cleanup(); }
});
