import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeJwt, importJWK, jwtVerify } from "jose";
import { getOrCreateKeypair } from "../src/keystore.ts";
import { signDpop } from "../src/dpop.ts";

test("signDpop produces a JWS verifiable under the public JWK", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-dpop-"));
  try {
    const kp = await getOrCreateKeypair(dir);
    const dpop = await signDpop(kp.privateJwk, "GET", "ws://localhost:7745/ws/daemon");

    const claims = decodeJwt(dpop);
    expect(claims.htm).toBe("GET");
    expect(claims.htu).toBe("ws://localhost:7745/ws/daemon");
    expect(claims.iat).toBeTruthy();
    expect(claims.jti).toBeTruthy();

    const pub = await importJWK(kp.publicJwk, "EdDSA");
    const v = await jwtVerify(dpop, pub);
    expect((v.protectedHeader as { alg: string }).alg).toBe("EdDSA");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("two signDpop calls produce different jti", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-dpop-"));
  try {
    const kp = await getOrCreateKeypair(dir);
    const a = await signDpop(kp.privateJwk, "GET", "ws://h/x");
    const b = await signDpop(kp.privateJwk, "GET", "ws://h/x");
    expect(decodeJwt(a).jti).not.toBe(decodeJwt(b).jti);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("end-to-end: hub verifies daemon-signed DPoP", async () => {
  const { generateKeyPair } = await import("jose");
  // Use jose's symmetric helper here so we don't depend on hub repo wiring.
  const { handlePair } = await import("../../hub/src/pair.ts");
  const { verifyDaemonAuth } = await import("../../hub/src/auth/dpop-verify.ts");
  const { openDb } = await import("../../hub/src/db.ts");
  const { issueCode } = await import("../../hub/src/repos/pairing-codes.ts");

  const dir = mkdtempSync(join(tmpdir(), "ccr-e2e-"));
  try {
    const db = openDb(join(dir, "h.sqlite"));
    db.prepare("INSERT INTO users (sub, created_at) VALUES (?, ?)").run("u1", 1);
    const code = issueCode(db, "daemon", "u1", null, 60_000);

    const kp = await getOrCreateKeypair(join(dir, "daemon-state"));
    const pair = await handlePair(db, "secret", {
      code, daemon_id: "d1", public_key_jwk: kp.publicJwk,
    });

    const url = "ws://localhost:7745/ws/daemon?daemon_id=d1";
    const dpop = await signDpop(kp.privateJwk, "GET", url);
    const result = await verifyDaemonAuth(db, "secret", "d1", pair.jwt, dpop, url, "GET");
    expect(result.daemon_id).toBe("d1");
    expect(result.owner_sub).toBe("u1");
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
