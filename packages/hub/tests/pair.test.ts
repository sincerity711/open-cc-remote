import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, exportJWK, jwtVerify, calculateJwkThumbprint, decodeJwt } from "jose";
import { openDb } from "../src/db.ts";
import { issueCode } from "../src/repos/pairing-codes.ts";
import { handlePair } from "../src/pair.ts";
import { findDaemon } from "../src/repos/daemons.ts";

async function genKeypair() {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
  const publicJwk = await exportJWK(publicKey);
  return { publicJwk, privateKey };
}

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), "ccr-pair-"));
  const db = openDb(join(dir, "h.sqlite"));
  return { db, dir, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("valid pair returns JWT with cnf.jkt", async () => {
  const { db, cleanup } = tmpDb();
  try {
    db.prepare("INSERT INTO users (sub, created_at) VALUES (?, ?)").run("u1", 1);
    const code = issueCode(db, "daemon", "u1", null, 60_000);
    const { publicJwk } = await genKeypair();
    const result = await handlePair(db, "test-secret", {
      code, daemon_id: "macbook", hostname: "Carls-Mac",
      public_key_jwk: publicJwk,
    });
    expect(result.jwt).toBeTruthy();
    expect(result.daemon_id).toBe("macbook");

    const claims = decodeJwt(result.jwt);
    const expectedThumbprint = await calculateJwkThumbprint(publicJwk);
    expect((claims.cnf as { jkt: string }).jkt).toBe(expectedThumbprint);
    expect(claims.sub).toBe("macbook");

    const { payload } = await jwtVerify(result.jwt, new TextEncoder().encode("test-secret"));
    expect(payload.sub).toBe("macbook");

    const row = findDaemon(db, "macbook");
    expect(row?.owner_sub).toBe("u1");
    expect(row?.jwt_jti).toBe(payload.jti);
  } finally { cleanup(); }
});

test("invalid code is rejected", async () => {
  const { db, cleanup } = tmpDb();
  try {
    db.prepare("INSERT INTO users (sub, created_at) VALUES (?, ?)").run("u1", 1);
    const { publicJwk } = await genKeypair();
    await expect(handlePair(db, "s", {
      code: "BOGUS-CODE", daemon_id: "d", public_key_jwk: publicJwk,
    })).rejects.toThrow(/invalid or expired code/);
  } finally { cleanup(); }
});

test("expired code is rejected", async () => {
  const { db, cleanup } = tmpDb();
  try {
    db.prepare("INSERT INTO users (sub, created_at) VALUES (?, ?)").run("u1", 1);
    const code = issueCode(db, "daemon", "u1", null, -1);
    const { publicJwk } = await genKeypair();
    await expect(handlePair(db, "s", {
      code, daemon_id: "d", public_key_jwk: publicJwk,
    })).rejects.toThrow();
  } finally { cleanup(); }
});

test("duplicate daemon_id is rejected", async () => {
  const { db, cleanup } = tmpDb();
  try {
    db.prepare("INSERT INTO users (sub, created_at) VALUES (?, ?)").run("u1", 1);
    const code1 = issueCode(db, "daemon", "u1", null, 60_000);
    const code2 = issueCode(db, "daemon", "u1", null, 60_000);
    const { publicJwk } = await genKeypair();
    await handlePair(db, "s", { code: code1, daemon_id: "macbook", public_key_jwk: publicJwk });
    await expect(handlePair(db, "s", { code: code2, daemon_id: "macbook", public_key_jwk: publicJwk }))
      .rejects.toThrow(/already taken/);
  } finally { cleanup(); }
});

test("invalid public_key_jwk is rejected", async () => {
  const { db, cleanup } = tmpDb();
  try {
    db.prepare("INSERT INTO users (sub, created_at) VALUES (?, ?)").run("u1", 1);
    const code = issueCode(db, "daemon", "u1", null, 60_000);
    await expect(handlePair(db, "s", {
      code, daemon_id: "d",
      public_key_jwk: { kty: "RSA", x: "wrong" } as any,
    })).rejects.toThrow(/invalid public_key_jwk/);
  } finally { cleanup(); }
});
