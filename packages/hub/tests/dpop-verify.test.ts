import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateKeyPair, exportJWK, SignJWT, type KeyLike,
} from "jose";
import { randomBytes } from "node:crypto";
import { openDb } from "../src/db.ts";
import { issueCode } from "../src/repos/pairing-codes.ts";
import { handlePair } from "../src/pair.ts";
import { verifyDaemonAuth } from "../src/auth/dpop-verify.ts";

const SECRET = "test-jwt-secret";

async function setupPaired() {
  const dir = mkdtempSync(join(tmpdir(), "ccr-dpop-"));
  const db = openDb(join(dir, "h.sqlite"));
  db.prepare("INSERT INTO users (sub, created_at) VALUES (?, ?)").run("u1", 1);
  const code = issueCode(db, "daemon", "u1", null, 60_000);
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
  const publicJwk = await exportJWK(publicKey);
  const result = await handlePair(db, SECRET, {
    code, daemon_id: "macbook", public_key_jwk: publicJwk,
  });
  return {
    db, dir, privateKey, publicJwk,
    daemon_id: "macbook", jwt: result.jwt,
    cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

async function makeDpop(privateKey: KeyLike, htm: string, htu: string, jti?: string) {
  return await new SignJWT({ htm, htu, jti: jti ?? randomBytes(8).toString("base64url") })
    .setProtectedHeader({ alg: "EdDSA" })
    .setIssuedAt()
    .sign(privateKey);
}

test("valid DPoP authentication succeeds", async () => {
  const s = await setupPaired();
  try {
    const url = "ws://localhost:7745/ws/daemon?daemon_id=macbook";
    const dpop = await makeDpop(s.privateKey, "GET", url);
    const r = await verifyDaemonAuth(s.db, SECRET, s.daemon_id, s.jwt, dpop, url, "GET");
    expect(r.daemon_id).toBe("macbook");
    expect(r.owner_sub).toBe("u1");
  } finally { s.cleanup(); }
});

test("DPoP htm mismatch is rejected", async () => {
  const s = await setupPaired();
  try {
    const url = "ws://localhost:7745/ws/daemon";
    const dpop = await makeDpop(s.privateKey, "POST", url);
    await expect(verifyDaemonAuth(s.db, SECRET, s.daemon_id, s.jwt, dpop, url, "GET"))
      .rejects.toThrow(/htm/);
  } finally { s.cleanup(); }
});

test("DPoP htu mismatch is rejected", async () => {
  const s = await setupPaired();
  try {
    const dpop = await makeDpop(s.privateKey, "GET", "ws://other-host/x");
    await expect(verifyDaemonAuth(s.db, SECRET, s.daemon_id, s.jwt, dpop, "ws://hub/x", "GET"))
      .rejects.toThrow(/htu/);
  } finally { s.cleanup(); }
});

test("DPoP jti replay is rejected", async () => {
  const s = await setupPaired();
  try {
    const url = "ws://x/y";
    const dpop = await makeDpop(s.privateKey, "GET", url, "fixed-jti");
    await verifyDaemonAuth(s.db, SECRET, s.daemon_id, s.jwt, dpop, url, "GET");
    await expect(verifyDaemonAuth(s.db, SECRET, s.daemon_id, s.jwt, dpop, url, "GET"))
      .rejects.toThrow(/replayed/);
  } finally { s.cleanup(); }
});

test("htu normalization: http<->ws and https<->wss", async () => {
  const s = await setupPaired();
  try {
    const wsUrl = "ws://h/y";
    const httpUrl = "http://h/y";
    const dpop = await makeDpop(s.privateKey, "GET", wsUrl);
    const r = await verifyDaemonAuth(s.db, SECRET, s.daemon_id, s.jwt, dpop, httpUrl, "GET");
    expect(r.daemon_id).toBe("macbook");
  } finally { s.cleanup(); }
});

test("revoked daemon is rejected", async () => {
  const s = await setupPaired();
  try {
    s.db.prepare("UPDATE daemons SET revoked_at = ? WHERE daemon_id = ?").run(1, "macbook");
    const dpop = await makeDpop(s.privateKey, "GET", "ws://h/y");
    await expect(verifyDaemonAuth(s.db, SECRET, s.daemon_id, s.jwt, dpop, "ws://h/y", "GET"))
      .rejects.toThrow(/revoked/);
  } finally { s.cleanup(); }
});

test("wrong daemon_id is rejected", async () => {
  const s = await setupPaired();
  try {
    const dpop = await makeDpop(s.privateKey, "GET", "ws://h/y");
    await expect(verifyDaemonAuth(s.db, SECRET, "other-daemon", s.jwt, dpop, "ws://h/y", "GET"))
      .rejects.toThrow(/sub mismatch/);
  } finally { s.cleanup(); }
});
