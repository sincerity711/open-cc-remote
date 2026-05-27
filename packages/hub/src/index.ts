import { loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { loadIas } from "./auth/ias.ts";
import { makeServer } from "./routes.ts";
import { createPushHelper } from "./push.ts";
import { initOtel, shutdownOtel } from "@cc-remote/observability";

void initOtel({ serviceName: "hub" });
process.on("SIGTERM", () => { void shutdownOtel(); });
process.on("SIGINT", () => { void shutdownOtel(); });

const cfg = loadConfig();
const db = openDb(cfg.db_path);
const ias = cfg.ias ? await loadIas(cfg.ias) : undefined;
const push = createPushHelper(cfg.vapid);

const offlinePushEnv = process.env.HUB_OFFLINE_PUSH_DELAY_MS;
const offline_push_delay_ms = offlinePushEnv !== undefined && offlinePushEnv !== ""
  ? Number(offlinePushEnv)
  : undefined;

const { fetch, websocket } = makeServer({
  db, ias, jwt_secret: cfg.jwt_secret, disable_auth: cfg.disable_auth, pwa_url: cfg.pwa_url, push,
  offline_push_delay_ms, static_dir: cfg.static_dir,
  trusted_proxies: cfg.trusted_proxies,
  rate_limit: cfg.rate_limit,
});
const server = Bun.serve({ port: cfg.port, fetch, websocket });
const flags = [
  ias ? "IAS enabled" : "no IAS",
  cfg.disable_auth ? "AUTH DISABLED" : "auth on",
];
console.log(`hub listening on http://localhost:${server.port} (${flags.join(", ")})`);
