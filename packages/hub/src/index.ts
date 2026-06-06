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

const { fetch, websocket, startHeartbeatWatchdog } = makeServer({
  db, ias, jwt_secret: cfg.jwt_secret, disable_auth: cfg.disable_auth, pwa_url: cfg.pwa_url, push,
  offline_push_delay_ms, static_dir: cfg.static_dir,
  trusted_proxies: cfg.trusted_proxies,
  rate_limit: cfg.rate_limit,
});
const server = Bun.serve({ port: cfg.port, fetch, websocket });
// Watchdog scans every 5s and closes any WS that hasn't produced a frame
// (including ping) in 45s. Catches NAT eviction + kernel-killed clients
// that never produced a clean FIN/RST. See spec
// docs/superpowers/specs/2026-06-06-ws-heartbeat-design.md for parameter
// justification.
const stopHeartbeatWatchdog = startHeartbeatWatchdog(5_000, 45_000);
process.on("SIGTERM", () => { stopHeartbeatWatchdog(); });
process.on("SIGINT", () => { stopHeartbeatWatchdog(); });
const flags = [
  ias ? "IAS enabled" : "no IAS",
  cfg.disable_auth ? "AUTH DISABLED" : "auth on",
];
console.log(`hub listening on http://localhost:${server.port} (${flags.join(", ")})`);
