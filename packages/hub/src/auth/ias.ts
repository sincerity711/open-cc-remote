import { randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Db } from "../db.ts";
import type { IasOidcConfig } from "../config.ts";
import { createDevice } from "../repos/devices.ts";

export interface IasContext {
  config: IasOidcConfig;
  authorize_endpoint: string;
  token_endpoint: string;
  jwks: ReturnType<typeof createRemoteJWKSet>;
  pendingStates: Map<string, number>; // state → exp epoch ms
}

export async function loadIas(config: IasOidcConfig): Promise<IasContext> {
  const res = await fetch(`${config.issuer_url}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`IAS discovery failed: ${res.status}`);
  const disc = (await res.json()) as {
    authorization_endpoint: string;
    token_endpoint: string;
    jwks_uri: string;
  };
  const jwks = createRemoteJWKSet(new URL(disc.jwks_uri));
  return {
    config,
    authorize_endpoint: disc.authorization_endpoint,
    token_endpoint: disc.token_endpoint,
    jwks,
    pendingStates: new Map(),
  };
}

export function startLogin(ctx: IasContext): { url: string } {
  const state = randomBytes(16).toString("base64url");
  ctx.pendingStates.set(state, Date.now() + 600_000);
  const params = new URLSearchParams({
    client_id: ctx.config.client_id,
    redirect_uri: ctx.config.redirect_uri,
    response_type: "code",
    scope: "openid email profile",
    state,
  });
  return { url: `${ctx.authorize_endpoint}?${params}` };
}

export interface CallbackResult {
  bearer: string;
  device_id: string;
  sub: string;
}

export async function handleCallback(
  ctx: IasContext,
  db: Db,
  query: URLSearchParams,
  user_agent: string | null,
): Promise<CallbackResult> {
  const code = query.get("code");
  const state = query.get("state");
  if (!code) throw new Error("missing code");
  if (!state) throw new Error("missing state");
  const exp = ctx.pendingStates.get(state);
  if (!exp) throw new Error("unknown state");
  ctx.pendingStates.delete(state);
  if (exp < Date.now()) throw new Error("state expired");

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: ctx.config.client_id,
    client_secret: ctx.config.client_secret,
    redirect_uri: ctx.config.redirect_uri,
  });
  const tokRes = await fetch(ctx.token_endpoint, { method: "POST", body });
  if (!tokRes.ok) throw new Error(`token exchange failed: ${tokRes.status}`);
  const tok = (await tokRes.json()) as { id_token?: string };
  if (!tok.id_token) throw new Error("no id_token in token response");

  const { payload } = await jwtVerify(tok.id_token, ctx.jwks, {
    issuer: ctx.config.issuer_url,
    audience: ctx.config.client_id,
  });
  const sub = payload.sub;
  if (!sub) throw new Error("id_token missing sub");
  if (!ctx.config.allowed_subjects.includes(sub)) {
    throw new Error(`subject ${sub} not in allowed_subjects`);
  }

  const now = Date.now();
  const email = (payload.email as string | undefined) ?? null;
  const display_name = (payload.name as string | undefined) ?? null;
  const existing = db.query("SELECT sub FROM users WHERE sub = ?").get(sub);
  if (existing) {
    db.prepare(
      "UPDATE users SET last_login_at = ?, email = COALESCE(?, email), display_name = COALESCE(?, display_name) WHERE sub = ?",
    ).run(now, email, display_name, sub);
  } else {
    db.prepare(
      "INSERT INTO users (sub, email, display_name, created_at, last_login_at) VALUES (?, ?, ?, ?, ?)",
    ).run(sub, email, display_name, now, now);
  }

  const ua = user_agent ?? "unknown";
  const created = createDevice(db, sub, uaShortName(ua), ua, 30 * 24 * 3600 * 1000);
  return { bearer: created.bearer, device_id: created.device_id, sub };
}

function uaShortName(ua: string): string {
  if (ua.includes("iPhone")) return "iPhone";
  if (ua.includes("iPad")) return "iPad";
  if (ua.includes("Android")) return "Android";
  if (ua.includes("Macintosh") || ua.includes("Mac OS X")) return "Mac";
  if (ua.includes("Windows")) return "Windows";
  if (ua.includes("Linux")) return "Linux";
  return "Browser";
}
