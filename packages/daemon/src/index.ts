import { hostname, homedir } from "node:os";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Socket } from "node:net";
import { spawn as childSpawn } from "node:child_process";
import type { JWK } from "jose";
import type { DaemonToHub, HubToDaemon, PluginToDaemon, SessionSnapshot } from "@cc-remote/proto";
import { loadConfig } from "./config.ts";
import { LiveSessions } from "./registry.ts";
import { startSocketServer } from "./socket-server.ts";
import { startHubClient } from "./hub-client.ts";
import { getOrCreateKeypair } from "./keystore.ts";
import { jsonlPath } from "./jsonl-paths.ts";
import { bindJsonl } from "./jsonl-bind.ts";
import { readHistory } from "./jsonl-history.ts";
import { startWatcher, type WatcherHandle } from "./jsonl-watcher.ts";
import { openDb } from "./db.ts";
import { recordRequest, resolveRequest } from "./repos/permissions.ts";
import { handleHubChatSend, handlePluginChatOut } from "./chat.ts";
import { SessionFsm } from "./session-fsm.ts";
import { ClaudeCodeAdapter } from "./adapters/claude-code.ts";

/**
 * Best-effort dismissal of Claude Code's interactive boot dialogs in a freshly-
 * spawned tmux session. A PWA-spawned pane has nobody attached to press Enter
 * — without this the new claude blocks forever on the dev-channels /
 * workspace-trust confirmations.
 *
 * Design: race two pane-watching promises.
 *   - readyPromise   → resolves when claude's TUI footer appears (no dialog
 *                       pending). Win → done.
 *   - dialogPromise  → resolves when a known confirm-dialog pattern appears.
 *                       Win → send Enter, re-race.
 * Both polls are infinite; one of them is guaranteed to win in normal claude
 * boot, so no outer timeout is needed.
 */
const DIALOG_RE = /Enter to confirm|local development|trust.*workspace|trust.*folder|safety check|created or one you trust/;
const READY_RE = /for agents|for shortcuts|shift\+tab to cycle|❯ Try/;
const POLL_INTERVAL_MS = 300;

function capturePane(tmuxName: string): Promise<string> {
  return new Promise((resolve) => {
    const r = childSpawn("tmux", ["capture-pane", "-t", tmuxName, "-p"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let buf = "";
    r.stdout?.on("data", (c: Buffer) => { buf += c.toString(); });
    r.on("close", () => resolve(buf));
    r.on("error", () => resolve(""));
  });
}

function sendEnter(tmuxName: string): Promise<void> {
  return new Promise((resolve) => {
    const r = childSpawn("tmux", ["send-keys", "-t", tmuxName, "Enter"], { stdio: "ignore" });
    r.on("close", () => resolve());
    r.on("error", () => resolve());
  });
}

function pollForRegex(tmuxName: string, re: RegExp): Promise<void> {
  return new Promise((resolve) => {
    const tick = async () => {
      const pane = await capturePane(tmuxName);
      if (re.test(pane)) return resolve();
      setTimeout(tick, POLL_INTERVAL_MS).unref();
    };
    void tick();
  });
}

function dismissClaudeDialogs(tmuxName: string): void {
  void (async () => {
    while (true) {
      const winner = await Promise.race([
        pollForRegex(tmuxName, READY_RE).then(() => "ready" as const),
        pollForRegex(tmuxName, DIALOG_RE).then(() => "dialog" as const),
      ]);
      if (winner === "ready") return;
      // Let the dialog settle, dispatch Enter, give claude time to update the
      // pane before re-racing (otherwise the dialog regex matches the same
      // stale capture and we double-press Enter).
      await new Promise((r) => setTimeout(r, 400));
      await sendEnter(tmuxName);
      await new Promise((r) => setTimeout(r, 400));
    }
  })();
}

const cfg = loadConfig();
const epoch = Math.floor(Date.now() / 1000);
const sessions = new LiveSessions();
const fsm = new SessionFsm();
const adapter = new ClaudeCodeAdapter();
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
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
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
      fsm.onPermissionResolved(frame.session_id);
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
      const claudeId = session.claude_session_id;
      if (!claudeId) {
        hub.send({
          type: "history_chunk",
          session_id: frame.session_id,
          request_id: frame.request_id,
          events: [],
        });
        return;
      }
      const path = jsonlPath(session.cwd, claudeId);
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
    else if (frame.type === "start_session") {
      if (!cfg.allow_start) {
        process.stderr.write(`daemon: start_session ignored (allow_start=false)\n`);
        return;
      }
      // Expand a leading "~" to $HOME before the prefix check. PWA composer
      // currently passes the literal user input.
      let cwd = frame.cwd;
      if (cwd === "~") cwd = homedir();
      else if (cwd.startsWith("~/")) cwd = join(homedir(), cwd.slice(2));
      const allowed = cfg.allowed_cwd_prefix.some((p) => cwd.startsWith(p));
      if (!allowed) {
        process.stderr.write(`daemon: start_session rejected — cwd ${cwd} not in allowed_cwd_prefix\n`);
        return;
      }
      // Create the cwd if it doesn't exist; otherwise tmux silently falls back
      // to $HOME and the spawn lands in the wrong place.
      try { mkdirSync(cwd, { recursive: true }); } catch (e) {
        process.stderr.write(`daemon: start_session mkdir failed for ${cwd}: ${(e as Error).message}\n`);
        return;
      }
      const tmuxName = frame.name ?? `cc-${Date.now()}`;
      try {
        const r = childSpawn("tmux", [
          "new-session", "-d",
          "-s", tmuxName,
          "-c", cwd,
          cfg.spawn_command,
        ], { stdio: "ignore", detached: true });
        r.on("error", (e) => {
          process.stderr.write(`daemon: start_session spawn error: ${e.message}\n`);
        });
        r.unref();
        process.stderr.write(`daemon: spawned tmux session ${tmuxName} in ${cwd}\n`);
        // Best-effort dismissal of Claude Code's interactive dialogs
        // (dev-channels confirmation, workspace-trust). Without this, a
        // PWA-driven new-session sits at the dialog forever — there's nobody
        // attached to press Enter. Mirrors the helper in tools/demo-channel.sh.
        dismissClaudeDialogs(tmuxName);
      } catch (e) {
        process.stderr.write(`daemon: start_session spawn threw: ${(e as Error).message}\n`);
      }
    }
    else if (frame.type === "chat_send") {
      // chat_send from hub → translate to chat_in and forward to the plugin's
      // Unix socket for the target session. Unknown session logs + drops.
      handleHubChatSend(frame, {
        sessionToClient,
        replyTo: (client, out) => sockServer.replyTo(client, out),
      });
    }
  },
  jwt,
  privateJwk,
});

sessions.onAdd((s: SessionSnapshot) => {
  fsm.register(s.session_id);
  hub.send({ type: "session_open", session: s });

  // Asynchronously bind the JSONL: discover the real claude_session_id
  // by watching the cwd's projects dir for a new .jsonl file.
  const projectsDirForCwd = dirname(jsonlPath(s.cwd, "_placeholder"));
  void bindJsonl({ dir: projectsDirForCwd, registerTimeMs: Date.now() }).then((claudeId) => {
    if (!claudeId) {
      process.stderr.write(`daemon: jsonl bind timed out for session ${s.session_id} (cwd=${s.cwd}); history will be unavailable\n`);
      return;
    }
    sessions.update(s.session_id, { claude_session_id: claudeId });

    const path = jsonlPath(s.cwd, claudeId);
    process.stderr.write(`daemon: jsonl bind resolved session=${s.session_id} claude=${claudeId} path=${path}\n`);
    const watcher = startWatcher({
      path,
      // startOffset: 0 — drain the entire JSONL on bind. The fs event that
      // resolves bindJsonl is *the same write* that prompted the bind (e.g.
      // the user-injected <channel> line); reading from current EOF would
      // skip past it. Re-emitting historic lines is safe because both the
      // hub event ring and the PWA `event` reducer dedupe by jsonl_offset.
      startOffset: 0,
      onLine: (line, jsonl_offset) => {
        let row: unknown;
        try { row = JSON.parse(line); } catch { row = { raw: line }; }
        const payload = adapter.convertRow(row, {
          sessionId: s.session_id,
          jsonlOffset: jsonl_offset,
        });
        hub.send({
          type: "event",
          session_id: s.session_id,
          jsonl_offset,
          ts: Date.now(),
          payload,
        });

        // Drive the session FSM. Every line is activity → working (unless
        // currently in `waiting` for a permission, in which case the FSM
        // remembers we'd be working and will pop back on resolve).
        fsm.onJsonlLine(s.session_id);

        // Idle timer:
        //   - `user` line               → new turn started, cancel any pending idle.
        //   - `assistant` w/o end_turn  → mid-turn streaming, cancel any pending idle.
        //   - `assistant` w/ end_turn   → fire task_completed + (re)arm idle timer.
        //   - everything else (system, summary, ai-title, last-prompt,
        //     permission-mode, …)      → leave the timer alone. Real Claude
        //     writes these as trailing metadata after end_turn; clearing the
        //     timer on them prevents idle from ever firing.
        const p = row as { type?: string; message?: { stop_reason?: string } };
        const cancelIdle = () => {
          const existing = idleTimers.get(s.session_id);
          if (existing) { clearTimeout(existing); idleTimers.delete(s.session_id); }
        };
        if (p.type === "user") {
          cancelIdle();
        } else if (p.type === "assistant") {
          if (p.message?.stop_reason === "end_turn") {
            cancelIdle();
            hub.send({ type: "task_completed", session_id: s.session_id, ts: Date.now() });
            const t = setTimeout(() => {
              idleTimers.delete(s.session_id);
              hub.send({ type: "idle", session_id: s.session_id, ts: Date.now() });
              fsm.onIdleTimer(s.session_id);
            }, cfg.idle_window_ms);
            t.unref();
            idleTimers.set(s.session_id, t);
          } else {
            cancelIdle();
          }
        }
      },
      onError: (e: Error) => process.stderr.write(`daemon: watcher error for ${s.session_id}: ${e.message}\n`),
    });
    watchers.set(s.session_id, watcher);
  });
});

sessions.onRemove((session_id: string) => {
  hub.send({ type: "session_close", session_id, reason: "plugin_bye" });
  fsm.remove(session_id);
  const w = watchers.get(session_id);
  if (w) {
    w.close();
    watchers.delete(session_id);
  }
  const t = idleTimers.get(session_id);
  if (t) { clearTimeout(t); idleTimers.delete(session_id); }
});

// FSM transitions → reflect into the cached SessionSnapshot AND broadcast a
// session_state frame so the hub can fan it out to PWAs in real time.
fsm.onTransition((session_id, state, prev) => {
  sessions.update(session_id, { state });
  hub.send({
    type: "session_state",
    session_id,
    state,
    prev,
    ts: Date.now(),
  });
});

const sockServer = startSocketServer({
  path: cfg.socket_path,
  onFrame: (frame: PluginToDaemon, client) => {
    if (frame.type === "register") {
      const isReregister = sessions.get(frame.session.session_id) !== undefined;
      sessions.add(frame.session);
      clientToSession.set(client, frame.session.session_id);
      sessionToClient.set(frame.session.session_id, client);
      sockServer.replyTo(client, { type: "ack", ref: "register" });
      process.stderr.write(
        `daemon: ${isReregister ? "re-register" : "register"} session=${frame.session.session_id} cwd=${frame.session.cwd}\n`,
      );
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
      fsm.onPermissionRequest(session_id);
      hub.send({
        type: "permission_request",
        session_id,
        request_id: frame.request_id,
        tool: frame.tool,
        args_summary: frame.args_summary,
        expires_at: frame.expires_at,
      });
    } else if (frame.type === "chat_out") {
      // Forward plugin's chat_out to the hub; hub will mint message_id + broadcast.
      handlePluginChatOut(frame, { send: (f) => hub.send(f) });
      sockServer.replyTo(client, { type: "ack", ref: "chat_out" });
    }
  },
  onClose: (client) => {
    const session_id = clientToSession.get(client);
    if (session_id) {
      sessionToClient.delete(session_id);
      sessions.remove(session_id);
    }
    clientToSession.delete(client);
    // Note: requestToClient entries from this client will leak until a hub
    // permission_reply tries to deliver and fails silently. Acceptable for v1
    // (Plan 4 doesn't include cleanup-on-disconnect; future plan can revisit).
  },
});

await sockServer.ready;
console.log(`daemon ${cfg.daemon_id} ready; socket=${cfg.socket_path}; hub=${cfg.hub_url}; auth=${jwt ? "on" : "off"}`);

const shutdown = () => {
  // Best-effort: tell connected plugins we're going down so they enter
  // reconnect mode immediately (instead of waiting for the socket close).
  // We give the write a brief tick to flush before tearing the socket down.
  for (const client of clientToSession.keys()) {
    try { sockServer.replyTo(client, { type: "daemon_going_down", reason: "shutdown" }); } catch {}
  }
  setTimeout(() => {
    for (const w of watchers.values()) w.close();
    watchers.clear();
    for (const t of idleTimers.values()) clearTimeout(t);
    idleTimers.clear();
    sockServer.close();
    hub.close();
    db.close();
    process.exit(0);
  }, 50);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
