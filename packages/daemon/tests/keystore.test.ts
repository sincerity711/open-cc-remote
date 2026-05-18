import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { getOrCreateKeypair } from "../src/keystore.ts";

test("first call generates keypair and writes both JWK files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-ks-"));
  try {
    const kp = await getOrCreateKeypair(dir);
    expect(kp.privateJwk.kty).toBe("OKP");
    expect(kp.privateJwk.crv).toBe("Ed25519");
    expect(kp.publicJwk.kty).toBe("OKP");
    expect(kp.publicJwk.crv).toBe("Ed25519");
    expect(kp.thumbprint).toMatch(/^[A-Za-z0-9_-]+$/);

    expect(existsSync(join(dir, "private.jwk"))).toBe(true);
    expect(existsSync(join(dir, "public.jwk"))).toBe(true);

    if (platform() !== "win32") {
      const privMode = statSync(join(dir, "private.jwk")).mode & 0o777;
      expect(privMode).toBe(0o600);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("second call returns the same keypair (idempotent)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-ks-"));
  try {
    const kp1 = await getOrCreateKeypair(dir);
    const kp2 = await getOrCreateKeypair(dir);
    expect(kp2.thumbprint).toBe(kp1.thumbprint);
    expect((kp2.publicJwk as { x: string }).x).toBe((kp1.publicJwk as { x: string }).x);
    expect((kp2.privateJwk as { d: string }).d).toBe((kp1.privateJwk as { d: string }).d);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("thumbprint matches jose's calculation", async () => {
  const { calculateJwkThumbprint } = await import("jose");
  const dir = mkdtempSync(join(tmpdir(), "ccr-ks-"));
  try {
    const kp = await getOrCreateKeypair(dir);
    const expected = await calculateJwkThumbprint(kp.publicJwk);
    expect(kp.thumbprint).toBe(expected);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
