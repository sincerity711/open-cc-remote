import { randomBytes } from "node:crypto";
import { parseTrustedProxies, type TrustedProxies } from "./proxy.ts";
import { loadRateLimitFromEnv, type RateLimitConfig } from "./rate-limit.ts";

export interface IasOidcConfig {
  issuer_url: string;
  client_id: string;
  client_secret: string;
  redirect_uri: string;
  allowed_subjects: string[];
}

export interface VapidConfig {
  public_key: string;
  private_key: string;
  subject: string;       // mailto: or https URL
}

export interface HubConfig {
  port: number;
  db_path: string;
  jwt_secret: string;
  disable_auth: boolean;
  pwa_url: string;
  static_dir?: string;
  ias?: IasOidcConfig;
  vapid?: VapidConfig;
  trusted_proxies: TrustedProxies;
  rate_limit: RateLimitConfig;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HubConfig {
  const port = Number(env.HUB_PORT ?? 17745);
  const db_path = env.HUB_DB_PATH ?? "./hub.sqlite";
  const jwt_secret = env.HUB_JWT_SECRET ?? randomBytes(32).toString("base64url");
  if (!env.HUB_JWT_SECRET) {
    process.stderr.write(
      "WARN: HUB_JWT_SECRET not set; using random ephemeral secret (all daemon JWTs invalidated on restart)\n",
    );
  }
  const disable_auth = env.HUB_DISABLE_AUTH === "1" || env.HUB_DISABLE_AUTH === "true";
  const pwa_url = env.HUB_PWA_URL ?? "/";

  const issuer_url = env.HUB_IAS_ISSUER;
  const client_id = env.HUB_IAS_CLIENT_ID;
  const client_secret = env.HUB_IAS_CLIENT_SECRET;
  const redirect_uri = env.HUB_IAS_REDIRECT_URI;
  const allowed = env.HUB_IAS_ALLOWED_SUBJECTS;

  let ias: IasOidcConfig | undefined;
  if (issuer_url && client_id && client_secret && redirect_uri && allowed) {
    ias = {
      issuer_url, client_id, client_secret, redirect_uri,
      allowed_subjects: allowed.split(",").map((s) => s.trim()).filter(Boolean),
    };
  }

  const vapid_public = env.HUB_VAPID_PUBLIC_KEY;
  const vapid_private = env.HUB_VAPID_PRIVATE_KEY;
  const vapid_subject = env.HUB_VAPID_SUBJECT;
  let vapid: VapidConfig | undefined;
  if (vapid_public && vapid_private && vapid_subject) {
    vapid = { public_key: vapid_public, private_key: vapid_private, subject: vapid_subject };
  } else if (vapid_public || vapid_private || vapid_subject) {
    process.stderr.write(
      "WARN: incomplete VAPID config (need HUB_VAPID_PUBLIC_KEY, HUB_VAPID_PRIVATE_KEY, HUB_VAPID_SUBJECT); Web Push disabled\n",
    );
  }

  return {
    port, db_path, jwt_secret, disable_auth, pwa_url,
    static_dir: env.HUB_STATIC_DIR, ias, vapid,
    trusted_proxies: parseTrustedProxies(env.HUB_TRUSTED_PROXIES),
    rate_limit: loadRateLimitFromEnv(env),
  };
}
