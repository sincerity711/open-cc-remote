import { hostname } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import type { JWK } from "jose";
import type { DaemonToHub, PluginToDaemon, SessionSnapshot } from "@cc-remote/proto";
import { loadConfig } from "./config.ts";
import { LiveSessions } from "./registry.ts";
import { startSocketServer } from "./socket-server.ts";
import { startHubClient } from "./hub-client.ts";
import { getOrCreateKeypair } from "./keystore.ts";
import { jsonlPath } from "./jsonl-paths.ts";
import { startWatcher, type WatcherHandle } from "./jsonl-watcher.ts";

const cfg = loadConfig();
const epoch = Math.floor(Date.now() / 1000);
const sessions = new LiveSessions();

const kp = await getOrCreateKeypair(cfg.state_dir);

let jwt: string | undefined;
let privateJwk: JWK | undefined;
if (existsSync(cfg.state_path)) {
  try {
    const state = JSON.parse(readFileSync(cfg.state_path, "utf8")) as { jwt?: string };
    if (state.jwt) {
      jwt = state.jwt;
      privateJwk = kp.privateJwk;
      process.stderr.write(`daemon: authenticated mode (jwt loaded from state.json)\n`);
    }
  } catch (e) {
    process.stderr.write(`daemon: warning, could not parse state.json: ${(e as Error).message}\n`);
  }
} else {
  process.stderr.write(`daemon: unauthenticated mode (no state.json — run 'cc-remote pair' to enable auth)\n`);
}

const hub = startHubClient({
  hub_url: cfg.hub_url,
  daemon_id: cfg.daemon_id,
  hello: () => ({
    type: "hello",
    daemon_id: cfg.daemon_id,
    epoch,
    hostname: hostname(),
    agent_version: "0.1.0",
    sessions: sessions.list(),
  }),
  onFrame: (_frame) => {},
  jwt,
  privateJwk,
});

const watchers = new Map<string, WatcherHandle>();

sessions.onAdd((s: SessionSnapshot) => {
  hub.send({ type: "session_open", session: s });

  // Start watching the session's JSONL.
  const path = jsonlPath(s.cwd, s.session_id);
  const watcher = startWatcher({
    path,
    onLine: (line, offset) => {
      let payload: unknown;
      try { payload = JSON.parse(line); } catch { payload = { raw: line }; }
      hub.send({
        type: "event",
        session_id: s.session_id,
        jsonl_offset: offset,
        ts: Date.now(),
        payload,
      });
    },
    onError: (e) => {
      process.stderr.write(`daemon: watcher error for ${s.session_id}: ${e.message}\n`);
    },
  });
  watchers.set(s.session_id, watcher);
});

sessions.onRemove((session_id: string) => {
  hub.send({ type: "session_close", session_id, reason: "plugin_bye" });
  const w = watchers.get(session_id);
  if (w) {
    w.close();
    watchers.delete(session_id);
  }
});

const sockServer = startSocketServer({
  path: cfg.socket_path,
  onFrame: (frame: PluginToDaemon, client) => {
    if (frame.type === "register") {
      sessions.add(frame.session);
      sockServer.replyTo(client, { type: "ack", ref: "register" });
    } else if (frame.type === "bye") {
      sessions.remove(frame.session_id);
      sockServer.replyTo(client, { type: "ack", ref: "bye" });
    }
  },
  onClose: () => {},
});

await sockServer.ready;
console.log(`daemon ${cfg.daemon_id} ready; socket=${cfg.socket_path}; hub=${cfg.hub_url}; auth=${jwt ? "on" : "off"}`);

const shutdown = () => {
  for (const w of watchers.values()) w.close();
  watchers.clear();
  sockServer.close();
  hub.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
