import { generateKeyPair, exportJWK, calculateJwkThumbprint, type JWK } from "jose";
import { readFileSync, writeFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface Keypair {
  privateJwk: JWK;
  publicJwk: JWK;
  thumbprint: string;
}

export async function getOrCreateKeypair(stateDir: string): Promise<Keypair> {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const privPath = join(stateDir, "private.jwk");
  const pubPath = join(stateDir, "public.jwk");

  if (existsSync(privPath) && existsSync(pubPath)) {
    const privateJwk = JSON.parse(readFileSync(privPath, "utf8")) as JWK;
    const publicJwk = JSON.parse(readFileSync(pubPath, "utf8")) as JWK;
    const thumbprint = await calculateJwkThumbprint(publicJwk);
    return { privateJwk, publicJwk, thumbprint };
  }

  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  const privateJwk = await exportJWK(privateKey);
  const publicJwk = await exportJWK(publicKey);

  writeFileSync(privPath, JSON.stringify(privateJwk));
  try { chmodSync(privPath, 0o600); } catch { /* Windows */ }
  writeFileSync(pubPath, JSON.stringify(publicJwk));
  try { chmodSync(pubPath, 0o600); } catch {}

  const thumbprint = await calculateJwkThumbprint(publicJwk);
  return { privateJwk, publicJwk, thumbprint };
}
