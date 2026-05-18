import { jwtVerify, importJWK, calculateJwkThumbprint, type JWK } from "jose";
import type { Db } from "../db.ts";
import { findDaemon, touchDaemon } from "../repos/daemons.ts";

const seenJtis = new Map<string, number>(); // jti → expiry epoch ms

const JTI_WINDOW_MS = 5 * 60_000;
const DPOP_IAT_TOLERANCE_SEC = 60;

function normalizeUrl(u: string): string {
  return u.replace(/^https:\/\//i, "wss://").replace(/^http:\/\//i, "ws://");
}

export interface DaemonAuthResult {
  daemon_id: string;
  owner_sub: string;
}

export async function verifyDaemonAuth(
  db: Db,
  jwt_secret: string,
  daemon_id: string,
  jwt: string,
  dpop: string,
  url: string,
  method: string,
): Promise<DaemonAuthResult> {
  // 1. Verify JWT (HS256, hub-issued at /pair)
  const secret = new TextEncoder().encode(jwt_secret);
  const { payload } = await jwtVerify(jwt, secret);
  if (payload.sub !== daemon_id) throw new Error("JWT sub mismatch");
  const cnf = payload.cnf as { jkt?: string } | undefined;
  if (!cnf?.jkt) throw new Error("JWT missing cnf.jkt");

  // 2. Lookup daemon row
  const daemon = findDaemon(db, daemon_id);
  if (!daemon) throw new Error("daemon not found");
  if (daemon.revoked_at !== null) throw new Error("daemon revoked");
  if (daemon.jwt_jti !== payload.jti) throw new Error("JWT jti not current");

  // 3. Verify DPoP JWS using daemon's stored public key
  const pubJwk = JSON.parse(daemon.public_key_jwk) as JWK;
  const actualJkt = await calculateJwkThumbprint(pubJwk);
  if (actualJkt !== cnf.jkt) throw new Error("JWK thumbprint mismatch");

  const pubKey = await importJWK(pubJwk, "EdDSA");
  const verified = await jwtVerify(dpop, pubKey);
  const dpopPayload = verified.payload as {
    htm?: string; htu?: string; iat?: number; jti?: string;
  };

  // 4. Check htm/htu/iat/jti
  if (dpopPayload.htm !== method) {
    throw new Error(`DPoP htm ${dpopPayload.htm} != ${method}`);
  }
  if (normalizeUrl(dpopPayload.htu ?? "") !== normalizeUrl(url)) {
    throw new Error(`DPoP htu mismatch: ${dpopPayload.htu} vs ${url}`);
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (!dpopPayload.iat || Math.abs(nowSec - dpopPayload.iat) > DPOP_IAT_TOLERANCE_SEC) {
    throw new Error("DPoP iat out of tolerance");
  }
  const dpopJti = dpopPayload.jti;
  if (!dpopJti) throw new Error("DPoP missing jti");

  const nowMs = Date.now();
  for (const [k, v] of seenJtis) if (v < nowMs) seenJtis.delete(k);
  if (seenJtis.has(dpopJti)) throw new Error("DPoP jti replayed");
  seenJtis.set(dpopJti, nowMs + JTI_WINDOW_MS);

  touchDaemon(db, daemon_id);
  return { daemon_id, owner_sub: daemon.owner_sub };
}
