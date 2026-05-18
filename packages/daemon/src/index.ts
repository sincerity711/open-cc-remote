import { hostname } from "node:os";
import type { DaemonToHub, PluginToDaemon, SessionSnapshot } from "@cc-remote/proto";
import { loadConfig } from "./config.ts";
import { LiveSessions } from "./registry.ts";
import { startSocketServer } from "./socket-server.ts";
import { startHubClient } from "./hub-client.ts";

const cfg = loadConfig();
const epoch = Math.floor(Date.now() / 1000);
const sessions = new LiveSessions();

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
  onFrame: (_frame) => {
    // Plan 1: hub-to-daemon frames (ping etc.) ignored.
  },
});

sessions.onAdd((s: SessionSnapshot) => {
  hub.send({ type: "session_open", session: s });
});
sessions.onRemove((session_id: string) => {
  hub.send({ type: "session_close", session_id, reason: "plugin_bye" });
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
  onClose: () => {
    // Plan 1 simplification: rely on explicit `bye`. Plan 2 adds
    // per-connection session tracking for ungraceful disconnects.
  },
});

await sockServer.ready;
console.log(`daemon ${cfg.daemon_id} ready; socket=${cfg.socket_path}; hub=${cfg.hub_url}`);

const shutdown = () => {
  sockServer.close();
  hub.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
