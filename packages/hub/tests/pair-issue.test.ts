import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, exportJWK } from "jose";
import { openDb } from "../src/db.ts";
import { createDevice } from "../src/repos/devices.ts";
import { handlePair } from "../src/pair.ts";
import { makeServer } from "../src/routes.ts";

function setupServer() {
  const dir = mkdtempSync(join(tmpdir(), "ccr-pi-"));
  const db = openDb(join(dir, "h.sqlite"));
  db.prepare("INSERT INTO users (sub, created_at) VALUES (?, ?)").run("u1", 1);
  const { fetch, websocket } = makeServer({ db, jwt_secret: "s", disable_auth: false, pwa_url: "/" });
  const server = Bun.serve({ port: 0, fetch, websocket });
  return {
    db, server,
    url: (path: string) => `http://localhost:${server.port}${path}`,
    cleanup: () => { server.stop(true); db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("POST /pair/issue returns code + ttl when authenticated", async () => {
  const s = setupServer();
  try {
    const dev = createDevice(s.db, "u1", "browser", null, 60_000);
    const res = await fetch(s.url("/pair/issue"), {
      method: "POST",
      headers: { authorization: `Bearer ${dev.bearer}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { code: string; expires_in_sec: number };
    expect(body.code).toMatch(/^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/);
    expect(body.expires_in_sec).toBe(300);
  } finally { s.cleanup(); }
});

test("POST /pair/issue without bearer returns 401", async () => {
  const s = setupServer();
  try {
    const res = await fetch(s.url("/pair/issue"), { method: "POST" });
    expect(res.status).toBe(401);
  } finally { s.cleanup(); }
});

test("issued code is consumable by handlePair exactly once", async () => {
  const s = setupServer();
  try {
    const dev = createDevice(s.db, "u1", "browser", null, 60_000);
    const res = await fetch(s.url("/pair/issue"), {
      method: "POST",
      headers: { authorization: `Bearer ${dev.bearer}` },
    });
    const { code } = await res.json() as { code: string };

    const { publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    const publicJwk = await exportJWK(publicKey);

    const result = await handlePair(s.db, "s", {
      code, daemon_id: "d-new", public_key_jwk: publicJwk,
    });
    expect(result.daemon_id).toBe("d-new");

    const { publicKey: pk2 } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    const pk2jwk = await exportJWK(pk2);
    await expect(handlePair(s.db, "s", {
      code, daemon_id: "d-second", public_key_jwk: pk2jwk,
    })).rejects.toThrow(/invalid or expired code/);
  } finally { s.cleanup(); }
});

test("issued code's metadata records issuer_sub for audit", async () => {
  const s = setupServer();
  try {
    const dev = createDevice(s.db, "u1", "browser", null, 60_000);
    const res = await fetch(s.url("/pair/issue"), {
      method: "POST",
      headers: { authorization: `Bearer ${dev.bearer}` },
    });
    const { code } = await res.json() as { code: string };
    const row = s.db.query("SELECT issuer_sub FROM pairing_codes WHERE code = ?").get(code) as { issuer_sub: string };
    expect(row.issuer_sub).toBe("u1");
  } finally { s.cleanup(); }
});
