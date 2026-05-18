import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import * as Codes from "../src/repos/pairing-codes.ts";
import * as Daemons from "../src/repos/daemons.ts";
import * as Devices from "../src/repos/devices.ts";

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), "ccr-repo-"));
  const db = openDb(join(dir, "t.sqlite"));
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

// ─── pairing-codes ─────────────────────────────────────────────────────

test("issueCode then consumeCode returns metadata", () => {
  const { db, cleanup } = tmpDb();
  try {
    const code = Codes.issueCode(db, "daemon", "u1", { daemon_id: "macbook" }, 60_000);
    expect(code).toMatch(/^[A-Z2-9]{3}-[A-Z2-9]{3}$/);
    const got = Codes.consumeCode(db, code);
    expect(got).toEqual({ kind: "daemon", issuer_sub: "u1", metadata: { daemon_id: "macbook" } });
  } finally { cleanup(); }
});

test("consumeCode twice — second returns null", () => {
  const { db, cleanup } = tmpDb();
  try {
    const code = Codes.issueCode(db, "daemon", "u1", null, 60_000);
    expect(Codes.consumeCode(db, code)).not.toBeNull();
    expect(Codes.consumeCode(db, code)).toBeNull();
  } finally { cleanup(); }
});

test("consumeCode with expired code returns null", () => {
  const { db, cleanup } = tmpDb();
  try {
    const code = Codes.issueCode(db, "daemon", "u1", null, -1);
    expect(Codes.consumeCode(db, code)).toBeNull();
  } finally { cleanup(); }
});

test("consumeCode with unknown code returns null", () => {
  const { db, cleanup } = tmpDb();
  try {
    expect(Codes.consumeCode(db, "ZZZ-ZZZ")).toBeNull();
  } finally { cleanup(); }
});

// ─── daemons ───────────────────────────────────────────────────────────

test("pairDaemon then findDaemon round-trips", () => {
  const { db, cleanup } = tmpDb();
  try {
    db.prepare("INSERT INTO users (sub, created_at) VALUES (?, ?)").run("u1", 1);
    Daemons.pairDaemon(db, "macbook", "u1", '{"kty":"OKP","crv":"Ed25519","x":"abc"}', "Carls-Mac");
    const got = Daemons.findDaemon(db, "macbook");
    expect(got?.owner_sub).toBe("u1");
    expect(got?.hostname).toBe("Carls-Mac");
    expect(got?.public_key_jwk).toBe('{"kty":"OKP","crv":"Ed25519","x":"abc"}');
    expect(got?.revoked_at).toBeNull();
  } finally { cleanup(); }
});

test("setJwtId updates jti+exp", () => {
  const { db, cleanup } = tmpDb();
  try {
    db.prepare("INSERT INTO users (sub, created_at) VALUES (?, ?)").run("u1", 1);
    Daemons.pairDaemon(db, "d1", "u1", "{}", null);
    Daemons.setJwtId(db, "d1", "jti-xyz", 9999);
    const got = Daemons.findDaemon(db, "d1");
    expect(got?.jwt_jti).toBe("jti-xyz");
    expect(got?.jwt_exp).toBe(9999);
  } finally { cleanup(); }
});

test("revokeDaemon sets revoked_at", () => {
  const { db, cleanup } = tmpDb();
  try {
    db.prepare("INSERT INTO users (sub, created_at) VALUES (?, ?)").run("u1", 1);
    Daemons.pairDaemon(db, "d1", "u1", "{}", null);
    Daemons.revokeDaemon(db, "d1");
    expect(Daemons.findDaemon(db, "d1")?.revoked_at).not.toBeNull();
  } finally { cleanup(); }
});

test("findDaemon returns null for unknown id", () => {
  const { db, cleanup } = tmpDb();
  try {
    expect(Daemons.findDaemon(db, "nope")).toBeNull();
  } finally { cleanup(); }
});

// ─── devices ───────────────────────────────────────────────────────────

test("createDevice + findDeviceByToken round-trip", () => {
  const { db, cleanup } = tmpDb();
  try {
    db.prepare("INSERT INTO users (sub, created_at) VALUES (?, ?)").run("u1", 1);
    const created = Devices.createDevice(db, "u1", "iPhone", "Mozilla/5.0", 30 * 24 * 3600 * 1000);
    expect(created.device_id).toMatch(/^dev-/);
    expect(created.bearer).toMatch(/^ccr_/);
    const found = Devices.findDeviceByToken(db, created.bearer);
    expect(found?.device_id).toBe(created.device_id);
    expect(found?.owner_sub).toBe("u1");
  } finally { cleanup(); }
});

test("findDeviceByToken with wrong token returns null", () => {
  const { db, cleanup } = tmpDb();
  try {
    db.prepare("INSERT INTO users (sub, created_at) VALUES (?, ?)").run("u1", 1);
    Devices.createDevice(db, "u1", "iPhone", null, 60_000);
    expect(Devices.findDeviceByToken(db, "ccr_bogus")).toBeNull();
  } finally { cleanup(); }
});

test("revokeDevice sets revoked_at", () => {
  const { db, cleanup } = tmpDb();
  try {
    db.prepare("INSERT INTO users (sub, created_at) VALUES (?, ?)").run("u1", 1);
    const c = Devices.createDevice(db, "u1", "iPhone", null, 60_000);
    Devices.revokeDevice(db, c.device_id);
    expect(Devices.findDeviceByToken(db, c.bearer)?.revoked_at).not.toBeNull();
  } finally { cleanup(); }
});
