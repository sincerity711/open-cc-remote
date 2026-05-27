// Route-level: confirm that DPoP htu is matched against the public URL
// reconstructed from XFP/XFH when the peer is a trusted proxy. Without trust,
// the hub falls back to scheme-collapse normalizeUrl (current behavior).

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, exportJWK, SignJWT, type KeyLike } from "jose";
import { randomBytes } from "node:crypto";
import { openDb } from "../src/db.ts";
import { issueCode } from "../src/repos/pairing-codes.ts";
import { handlePair } from "../src/pair.ts";
import { makeServer } from "../src/routes.ts";
import { parseTrustedProxies } from "../src/proxy.ts";

const SECRET = "test-jwt-secret";

async function setup(trusted: string) {
  const dir = mkdtempSync(join(tmpdir(), "ccr-htu-"));
  const db = openDb(join(dir, "h.sqlite"));
  db.prepare("INSERT INTO users (sub, created_at) VALUES (?, ?)").run("u1", 1);
  const code = issueCode(db, "daemon", "u1", null, 60_000);
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
  const publicJwk = await exportJWK(publicKey);
  const result = await handlePair(db, SECRET, {
    code, daemon_id: "macbook", public_key_jwk: publicJwk,
  });
  const { fetch, websocket } = makeServer({
    db, jwt_secret: SECRET, disable_auth: false, pwa_url: "/",
    trusted_proxies: parseTrustedProxies(trusted),
  });
  const server = Bun.serve({ port: 0, fetch, websocket });
  return {
    db, server, privateKey, jwt: result.jwt,
    cleanup: () => { server.stop(true); db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

async function makeDpop(privateKey: KeyLike, htm: string, htu: string) {
  return await new SignJWT({ htm, htu, jti: randomBytes(8).toString("base64url") })
    .setProtectedHeader({ alg: "EdDSA" })
    .setIssuedAt()
    .sign(privateKey);
}

test("XFP/XFH from trusted proxy reconstructs htu against public URL", async () => {
  const s = await setup("127.0.0.1,::1");
  try {
    // Daemon signs the public URL it actually addressed.
    const publicUrl = `https://hub.example.com/pair/refresh`;
    const dpop = await makeDpop(s.privateKey, "POST", publicUrl);
    const res = await fetch(`http://localhost:${s.server.port}/pair/refresh`, {
      method: "POST",
      headers: {
        authorization: `DPoP ${s.jwt}`,
        dpop,
        "x-forwarded-proto": "https",
        "x-forwarded-host": "hub.example.com",
      },
    });
    // 200 = htu matched against reconstructed public URL.
    expect(res.status).toBe(200);
  } finally { s.cleanup(); }
});

test("untrusted peer ignores XFP — htu must match req.url scheme-collapsed", async () => {
  // Trust nobody — XFP must NOT be honored even if a forged header arrives.
  const s = await setup("");
  try {
    // Daemon (or attacker) signs against forged public URL.
    const forgedUrl = `https://hub.example.com/pair/refresh`;
    const dpop = await makeDpop(s.privateKey, "POST", forgedUrl);
    const res = await fetch(`http://localhost:${s.server.port}/pair/refresh`, {
      method: "POST",
      headers: {
        authorization: `DPoP ${s.jwt}`,
        dpop,
        "x-forwarded-proto": "https",
        "x-forwarded-host": "hub.example.com",
      },
    });
    // 401 = htu mismatch (req.url has localhost host, not hub.example.com).
    expect(res.status).toBe(401);
  } finally { s.cleanup(); }
});
