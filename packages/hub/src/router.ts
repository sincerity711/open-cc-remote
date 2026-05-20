import type {
  DaemonToHub, HubToPwa, HubToDaemonStartSession, SessionSnapshot, DaemonView, EventFrameForPwa, PwaToHub,
  PwaToHubChatSend, HubToDaemonChatSend,
} from "@cc-remote/proto";
import type { DaemonRegistry, PwaRegistry } from "./connections.ts";
import type { Db } from "./db.ts";
import type { PushHelper } from "./push.ts";
import { ulid } from "./ulid.ts";

const RING_BUFFER_SIZE = 200;
const DEFAULT_OFFLINE_PUSH_DELAY_MS = 30_000;

interface DaemonState {
  daemon_id: string;
  hostname: string;
  epoch: number;
  sessions: Map<string, SessionSnapshot>;
  events: EventFrameForPwa[];
}

export interface RouterOptions {
  offline_push_delay_ms?: number;
}

export class Router {
  private daemons = new Map<string, DaemonState>();
  private offlineTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private offlineMeta = new Map<string, { hostname: string; disconnected_at: number }>();
  private offlinePushDelayMs: number;

  constructor(
    private daemonReg: DaemonRegistry<unknown>,
    private pwaReg: PwaRegistry<unknown>,
    private db?: Db,
    private push?: PushHelper,
    options: RouterOptions = {},
  ) {
    this.offlinePushDelayMs = options.offline_push_delay_ms ?? DEFAULT_OFFLINE_PUSH_DELAY_MS;
  }

  onDaemonFrame(daemon_id: string, frame: DaemonToHub): void {
    switch (frame.type) {
      case "hello": {
        // Cancel any pending offline-push timer for this daemon.
        const t = this.offlineTimers.get(daemon_id);
        if (t) { clearTimeout(t); this.offlineTimers.delete(daemon_id); }
        this.offlineMeta.delete(daemon_id);

        const state: DaemonState = {
          daemon_id,
          hostname: frame.hostname,
          epoch: frame.epoch,
          sessions: new Map(frame.sessions.map((s) => [s.session_id, s])),
          events: [],
        };
        this.daemons.set(daemon_id, state);
        this.pwaReg.broadcast({
          type: "daemon_online", daemon_id, hostname: frame.hostname, sessions: frame.sessions,
        });
        return;
      }
      case "session_open": {
        const state = this.daemons.get(daemon_id);
        if (!state) return;
        state.sessions.set(frame.session.session_id, frame.session);
        this.pwaReg.broadcast({ type: "session_open", daemon_id, session: frame.session });
        return;
      }
      case "session_close": {
        const state = this.daemons.get(daemon_id);
        if (!state) return;
        state.sessions.delete(frame.session_id);
        this.pwaReg.broadcast({ type: "session_close", daemon_id, session_id: frame.session_id, reason: frame.reason });
        return;
      }
      case "event": {
        const state = this.daemons.get(daemon_id);
        if (!state) return;
        const out: EventFrameForPwa = {
          type: "event", daemon_id,
          session_id: frame.session_id, jsonl_offset: frame.jsonl_offset,
          ts: frame.ts, payload: frame.payload,
        };
        state.events.push(out);
        if (state.events.length > RING_BUFFER_SIZE) state.events.shift();
        this.pwaReg.broadcast(out);
        return;
      }
      case "permission_request": {
        const state = this.daemons.get(daemon_id);
        if (!state) return;
        this.pwaReg.broadcast({
          type: "permission_request", daemon_id,
          session_id: frame.session_id, request_id: frame.request_id,
          tool: frame.tool, args_summary: frame.args_summary, expires_at: frame.expires_at,
        });
        if (this.db && this.push) void this.dispatchPush(daemon_id, frame);
        return;
      }
      case "permission_resolved": {
        const state = this.daemons.get(daemon_id);
        if (!state) return;
        this.pwaReg.broadcast({
          type: "permission_resolved", daemon_id,
          session_id: frame.session_id, request_id: frame.request_id,
          decision: frame.decision, decided_via: frame.decided_via,
        });
        return;
      }
      case "history_chunk": {
        const state = this.daemons.get(daemon_id);
        if (!state) return;
        this.pwaReg.broadcast({
          type: "history_chunk", daemon_id,
          session_id: frame.session_id, request_id: frame.request_id, events: frame.events,
        });
        return;
      }
      case "pong":
        return;
      case "task_completed": {
        const state = this.daemons.get(daemon_id);
        if (!state) return;
        this.pwaReg.broadcast({
          type: "task_completed",
          daemon_id,
          session_id: frame.session_id,
          ts: frame.ts,
        });
        if (this.db && this.push) void this.dispatchCompletedPush(daemon_id, frame);
        return;
      }
      case "idle": {
        const state = this.daemons.get(daemon_id);
        if (!state) return;
        this.pwaReg.broadcast({
          type: "idle",
          daemon_id,
          session_id: frame.session_id,
          ts: frame.ts,
        });
        if (this.db && this.push) void this.dispatchIdlePush(daemon_id, frame);
        return;
      }
      case "chat_out": {
        const state = this.daemons.get(daemon_id);
        if (!state) return;
        this.pwaReg.broadcast({
          type: "chat",
          daemon_id,
          session_id: frame.session_id,
          message_id: ulid(),
          from: "claude",
          user: null,
          content: frame.content,
          reply_to: frame.reply_to,
          ts: frame.ts,
        });
        return;
      }
    }
  }

  private async dispatchPush(
    daemon_id: string,
    frame: { session_id: string; request_id: string; tool: string; args_summary: string },
  ): Promise<void> {
    if (!this.db || !this.push) return;
    const { findDaemon } = await import("./repos/daemons.ts");
    const { findSubsByOwner } = await import("./repos/push-subs.ts");
    const daemon = findDaemon(this.db, daemon_id);
    if (!daemon) return;
    const allSubs = findSubsByOwner(this.db, daemon.owner_sub);
    const subs = allSubs.filter((s) => s.preferences.permission !== false);
    if (subs.length === 0) return;
    await this.push.sendTo(subs, {
      kind: "permission",
      daemon_id, session_id: frame.session_id, request_id: frame.request_id,
      tool: frame.tool, args_summary: frame.args_summary,
    });
  }

  private async dispatchOfflinePush(daemon_id: string, hostname: string, sinceMs: number): Promise<void> {
    if (!this.db || !this.push) return;
    const { findDaemon } = await import("./repos/daemons.ts");
    const { findSubsByOwner } = await import("./repos/push-subs.ts");
    const daemon = findDaemon(this.db, daemon_id);
    if (!daemon) return;
    const allSubs = findSubsByOwner(this.db, daemon.owner_sub);
    const subs = allSubs.filter((s) => s.preferences.offline === true);
    if (subs.length === 0) return;
    await this.push.sendTo(subs, {
      kind: "offline",
      daemon_id, hostname, since_ms: sinceMs,
    });
  }

  private async dispatchCompletedPush(
    daemon_id: string,
    frame: { session_id: string },
  ): Promise<void> {
    if (!this.db || !this.push) return;
    const { findDaemon } = await import("./repos/daemons.ts");
    const { findSubsByOwner } = await import("./repos/push-subs.ts");
    const daemon = findDaemon(this.db, daemon_id);
    if (!daemon) return;
    const allSubs = findSubsByOwner(this.db, daemon.owner_sub);
    const subs = allSubs.filter((s) => s.preferences.completed === true);
    if (subs.length === 0) return;
    await this.push.sendTo(subs, {
      kind: "completed",
      daemon_id, session_id: frame.session_id,
    });
  }

  private async dispatchIdlePush(
    daemon_id: string,
    frame: { session_id: string },
  ): Promise<void> {
    if (!this.db || !this.push) return;
    const { findDaemon } = await import("./repos/daemons.ts");
    const { findSubsByOwner } = await import("./repos/push-subs.ts");
    const daemon = findDaemon(this.db, daemon_id);
    if (!daemon) return;
    const allSubs = findSubsByOwner(this.db, daemon.owner_sub);
    const subs = allSubs.filter((s) => s.preferences.idle === true);
    if (subs.length === 0) return;
    await this.push.sendTo(subs, {
      kind: "idle",
      daemon_id, session_id: frame.session_id,
    });
  }

  onDaemonDisconnect(daemon_id: string): void {
    const state = this.daemons.get(daemon_id);
    if (!state) return;
    const hostname = state.hostname;
    const disconnected_at = Date.now();

    this.daemons.delete(daemon_id);
    this.pwaReg.broadcast({ type: "daemon_offline", daemon_id });

    // Schedule offline push if not already scheduled.
    if (this.offlineTimers.has(daemon_id)) return;
    this.offlineMeta.set(daemon_id, { hostname, disconnected_at });
    const timer = setTimeout(() => {
      this.offlineTimers.delete(daemon_id);
      const meta = this.offlineMeta.get(daemon_id);
      this.offlineMeta.delete(daemon_id);
      if (!meta) return;
      void this.dispatchOfflinePush(daemon_id, meta.hostname, Date.now() - meta.disconnected_at);
    }, this.offlinePushDelayMs);
    // Don't keep the event loop alive just for this timer.
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
    this.offlineTimers.set(daemon_id, timer);
  }

  onPwaSubscribe(send: (f: HubToPwa) => void): void {
    send({ type: "snapshot", daemons: this.snapshot() });
  }

  onPwaCommand(frame: PwaToHub): void {
    if (frame.type === "permission_reply") {
      this.daemonReg.send(frame.daemon_id, {
        type: "permission_reply", session_id: frame.session_id,
        request_id: frame.request_id, decision: frame.decision,
      });
    } else if (frame.type === "request_history") {
      this.daemonReg.send(frame.daemon_id, {
        type: "request_history", session_id: frame.session_id,
        request_id: frame.request_id, before_offset: frame.before_offset, limit: frame.limit,
      });
    } else if (frame.type === "kill_session") {
      this.daemonReg.send(frame.daemon_id, {
        type: "kill_session",
        session_id: frame.session_id,
      });
    } else if (frame.type === "start_session") {
      const out: HubToDaemonStartSession = {
        type: "start_session",
        cwd: frame.cwd,
      };
      if (frame.name !== undefined) out.name = frame.name;
      this.daemonReg.send(frame.daemon_id, out);
    }
  }

  /**
   * Handle a PWA-issued chat_send: resolve user, generate message_id, forward
   * to the addressed daemon, and broadcast the echo to all PWA subscribers.
   * If the daemon is offline, send a chat_error back to the sender only.
   */
  onPwaChatSend(
    frame: PwaToHubChatSend,
    auth: { user: string; user_id: string },
    senderSend: (f: HubToPwa) => void,
  ): void {
    const message_id = ulid();
    const ts = Math.floor(Date.now() / 1000);
    const reply_to = frame.reply_to ?? null;

    if (!this.daemonReg.has(frame.daemon_id)) {
      senderSend({
        type: "chat_error",
        daemon_id: frame.daemon_id,
        session_id: frame.session_id,
        reason: "daemon_offline",
      });
      return;
    }

    const out: HubToDaemonChatSend = {
      type: "chat_send",
      session_id: frame.session_id,
      message_id,
      user: auth.user,
      user_id: auth.user_id,
      content: frame.content,
      reply_to,
      ts,
    };
    this.daemonReg.send(frame.daemon_id, out);

    this.pwaReg.broadcast({
      type: "chat",
      daemon_id: frame.daemon_id,
      session_id: frame.session_id,
      message_id,
      from: "pwa",
      user: auth.user,
      content: frame.content,
      reply_to,
      ts,
    });
  }

  snapshot(): DaemonView[] {
    return [...this.daemons.values()].map((d) => ({
      daemon_id: d.daemon_id, hostname: d.hostname, online: true,
      sessions: [...d.sessions.values()],
    }));
  }

  bufferOf(daemon_id: string): EventFrameForPwa[] {
    return this.daemons.get(daemon_id)?.events ?? [];
  }
}
