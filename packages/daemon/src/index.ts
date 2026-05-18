import { loadConfig } from "./config.ts";

const cfg = loadConfig();
console.log(`daemon ${cfg.daemon_id} starting; will connect ${cfg.hub_url}`);
console.log(`socket path: ${cfg.socket_path}`);
// Real wiring in Tasks 8–10.
