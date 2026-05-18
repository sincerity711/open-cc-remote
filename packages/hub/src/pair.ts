import { SignJWT, calculateJwkThumbprint, importJWK, type JWK } from "jose";
import { randomBytes } from "node:crypto";
import type { Db } from "./db.ts";
import { consumeCode } from "./repos/pairing-codes.ts";
import { pairDaemon, findDaemon, setJwtId } from "./repos/daemons.ts";

export const JWT_TTL_SEC = 24 * 3600;

export interface PairRequest {
  code: string;
  daemon_id: string;
  hostname?: string;
  public_key_jwk: JWK;
}

export interface PairResponse {
  jwt: string;
  daemon_id: string;
  exp: number;
}

export async function handlePair(
  db: Db,
  jwt_secret: string,
  body: PairRequest,
): Promise<PairResponse> {
  if (!body.code || !body.daemon_id || !body.public_key_jwk) {
    throw new Error("missing required fields");
  }
  // Validate JWK by attempting to import.
  try {
    await importJWK(body.public_key_jwk, "EdDSA");
  } catch (e) {
    throw new Error(`invalid public_key_jwk: ${(e as Error).message}`);
  }
  const jkt = await calculateJwkThumbprint(body.public_key_jwk);

  if (findDaemon(db, body.daemon_id)) {
    throw new Error(`daemon_id ${body.daemon_id} already taken`);
  }

  const consumed = consumeCode(db, body.code);
  if (!consumed) throw new Error("invalid or expired code");
  if (consumed.kind !== "daemon") throw new Error(`code kind ${consumed.kind} not allowed here`);

  pairDaemon(
    db, body.daemon_id, consumed.issuer_sub,
    JSON.stringify(body.public_key_jwk), body.hostname ?? null,
  );

  const now = Math.floor(Date.now() / 1000);
  const exp = now + JWT_TTL_SEC;
  const jti = randomBytes(16).toString("base64url");
  const secret = new TextEncoder().encode(jwt_secret);

  const jwt = await new SignJWT({ cnf: { jkt } })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(body.daemon_id)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .setJti(jti)
    .sign(secret);

  setJwtId(db, body.daemon_id, jti, exp);
  return { jwt, daemon_id: body.daemon_id, exp };
}

export async function refreshJwt(
  db: Db,
  jwt_secret: string,
  daemon_id: string,
): Promise<PairResponse> {
  const daemon = findDaemon(db, daemon_id);
  if (!daemon) throw new Error("daemon not found");
  if (daemon.revoked_at) throw new Error("daemon revoked");

  const now = Math.floor(Date.now() / 1000);
  const exp = now + JWT_TTL_SEC;
  const jti = randomBytes(16).toString("base64url");
  const secret = new TextEncoder().encode(jwt_secret);
  const publicKey = JSON.parse(daemon.public_key_jwk);
  const jkt = await calculateJwkThumbprint(publicKey);

  const jwt = await new SignJWT({ cnf: { jkt } })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(daemon_id)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .setJti(jti)
    .sign(secret);

  setJwtId(db, daemon_id, jti, exp);
  return { jwt, daemon_id, exp };
}
