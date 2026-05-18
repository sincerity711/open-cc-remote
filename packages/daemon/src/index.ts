import { hostname } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Socket } from "node:net";
import type { JWK } from "jose";
import type { DaemonToHub, HubToDaemon, PluginToDaemon, SessionSnapshot } from "@cc-remote/proto";
import { loadConfig } from "./config.ts";
import { LiveSessions } from "./registry.ts";
import { startSocketServer } from "./socket-server.ts";
import { startHubClient } from "./hub-client.ts";
import { getOrCreateKeypair } from "./keystore.ts";
import { jsonlPath } from "./jsonl-paths.ts";
import { readHistory } from "./jsonl-history.ts";
import { startWatcher, type WatcherHandle } from "./jsonl-watcher.ts";
import { openDb } from "./db.ts";
import { recordRequest, resolveRequest } from "./repos/permissions.ts";

const cfg = loadConfig();
const epoch = Math.floor(Date.now() / 1000);
const sessions = new LiveSessions();
const db = openDb(join(cfg.state_dir, "db.sqlite"));

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

const watchers = new Map<string, WatcherHandle>();
const clientToSession = new Map<Socket, string>();
const sessionToClient = new Map<string, Socket>();
const requestToClient = new Map<string, Socket>();

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
  onFrame: (frame: HubToDaemon) => {
    if (frame.type === "permission_reply") {
      const ok = resolveRequest(db, frame.request_id, frame.decision, "pwa");
      if (!ok) return; // already resolved
      const client = requestToClient.get(frame.request_id);
      if (client) {
        sockServer.replyTo(client, {
          type: "permission_reply",
          request_id: frame.request_id,
          decision: frame.decision,
        });
        requestToClient.delete(frame.request_id);
      }
      hub.send({
        type: "permission_resolved",
        session_id: frame.session_id,
        request_id: frame.request_id,
        decision: frame.decision,
        decided_via: "pwa",
      });
    } else if (frame.type === "request_history") {
      const session = sessions.get(frame.session_id);
      if (!session) {
        hub.send({
          type: "history_chunk",
          session_id: frame.session_id,
          request_id: frame.request_id,
          events: [],
        });
        return;
      }
      const path = jsonlPath(session.cwd, frame.session_id);
      readHistory(path, frame.before_offset, frame.limit).then((events) => {
        hub.send({
          type: "history_chunk",
          session_id: frame.session_id,
          request_id: frame.request_id,
          events,
        });
      }).catch((e) => {
        process.stderr.write(`daemon: history read failed for ${frame.session_id}: ${(e as Error).message}\n`);
        hub.send({
          type: "history_chunk",
          session_id: frame.session_id,
          request_id: frame.request_id,
          events: [],
        });
      });
    }
    else if (frame.type === "kill_session") {
      if (!cfg.allow_kill) {
        process.stderr.write(`daemon: kill_session ignored (allow_kill=false in config)\n`);
        return;
      }
      const client = sessionToClient.get(frame.session_id);
      if (!client) {
        process.stderr.write(`daemon: kill_session for unknown session ${frame.session_id}\n`);
        return;
      }
      process.stderr.write(`daemon: killing session ${frame.session_id}\n`);
      try { client.destroy(); } catch {}
    }
  },
  jwt,
  privateJwk,
});

sessions.onAdd((s: SessionSnapshot) => {
  hub.send({ type: "session_open", session: s });
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
      clientToSession.set(client, frame.session.session_id);
      sessionToClient.set(frame.session.session_id, client);
      sockServer.replyTo(client, { type: "ack", ref: "register" });
    } else if (frame.type === "bye") {
      sessions.remove(frame.session_id);
      clientToSession.delete(client);
      sessionToClient.delete(frame.session_id);
      sockServer.replyTo(client, { type: "ack", ref: "bye" });
    } else if (frame.type === "permission_request") {
      const session_id = clientToSession.get(client);
      if (!session_id) {
        process.stderr.write(`daemon: permission_request from unregistered plugin client\n`);
        return;
      }
      recordRequest(db, frame.request_id, session_id, frame.tool, frame.args_summary);
      requestToClient.set(frame.request_id, client);
      hub.send({
        type: "permission_request",
        session_id,
        request_id: frame.request_id,
        tool: frame.tool,
        args_summary: frame.args_summary,
        expires_at: frame.expires_at,
      });
    }
  },
  onClose: (client) => {
    const session_id = clientToSession.get(client);
    if (session_id) sessionToClient.delete(session_id);
    clientToSession.delete(client);
    // Note: requestToClient entries from this client will leak until a hub
    // permission_reply tries to deliver and fails silently. Acceptable for v1
    // (Plan 4 doesn't include cleanup-on-disconnect; future plan can revisit).
  },
});

await sockServer.ready;
console.log(`daemon ${cfg.daemon_id} ready; socket=${cfg.socket_path}; hub=${cfg.hub_url}; auth=${jwt ? "on" : "off"}`);

const shutdown = () => {
  for (const w of watchers.values()) w.close();
  watchers.clear();
  sockServer.close();
  hub.close();
  db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
