import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, exportJWK, decodeJwt } from "jose";
import { openDb } from "../src/db.ts";
import { issueCode } from "../src/repos/pairing-codes.ts";
import { handlePair, refreshJwt } from "../src/pair.ts";

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "ccr-rf-"));
  const db = openDb(join(dir, "h.sqlite"));
  db.prepare("INSERT INTO users (sub, created_at) VALUES (?, ?)").run("u1", 1);
  const code = issueCode(db, "daemon", "u1", null, 60_000);
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
  const publicJwk = await exportJWK(publicKey);
  const paired = await handlePair(db, "secret", { code, daemon_id: "d1", public_key_jwk: publicJwk });
  return {
    db, dir, privateKey, publicJwk,
    daemon_id: "d1",
    initialJwt: paired.jwt,
    cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("refreshJwt issues new jwt with new jti and updates daemon row", async () => {
  const s = await setup();
  try {
    const result = await refreshJwt(s.db, "secret", s.daemon_id);
    expect(result.jwt).toBeTruthy();
    expect(result.jwt).not.toBe(s.initialJwt);
    const oldClaims = decodeJwt(s.initialJwt);
    const newClaims = decodeJwt(result.jwt);
    expect(newClaims.jti).not.toBe(oldClaims.jti);
    const row = s.db.query("SELECT jwt_jti FROM daemons WHERE daemon_id = ?").get("d1") as { jwt_jti: string };
    expect(row.jwt_jti).toBe(newClaims.jti!);
  } finally { s.cleanup(); }
});

test("refreshJwt fails on revoked daemon", async () => {
  const s = await setup();
  try {
    s.db.prepare("UPDATE daemons SET revoked_at = ? WHERE daemon_id = ?").run(1, "d1");
    await expect(refreshJwt(s.db, "secret", "d1")).rejects.toThrow(/revoked/);
  } finally { s.cleanup(); }
});

test("refreshJwt fails on unknown daemon", async () => {
  const s = await setup();
  try {
    await expect(refreshJwt(s.db, "secret", "nope")).rejects.toThrow(/not found/);
  } finally { s.cleanup(); }
});
