import { loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { loadIas } from "./auth/ias.ts";
import { makeServer } from "./routes.ts";

const cfg = loadConfig();
const db = openDb(cfg.db_path);
const ias = cfg.ias ? await loadIas(cfg.ias) : undefined;

const { fetch, websocket } = makeServer({ db, ias });
const server = Bun.serve({ port: cfg.port, fetch, websocket });
console.log(`hub listening on http://localhost:${server.port}${ias ? " (IAS enabled)" : " (no auth)"}`);
