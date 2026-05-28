import type {
  DaemonToHub, HubToPwa, HubToDaemonStartSession, SessionSnapshot, DaemonView, EventFrameForPwa, PwaToHub,
  PwaToHubChatSend, HubToDaemonChatSend, HubChatErrorBroadcast,
  PwaToHubCliCommand, HubToDaemonCliCommand,
  PwaAskUserQuestionRequest,
  PwaSlashInventory, SlashEntry,
} from "@cc-remote/proto";
import type { DaemonRegistry, PwaRegistry } from "./connections.ts";
import type { Db } from "./db.ts";
import type { PushHelper } from "./push.ts";
import { findDaemon } from "./repos/daemons.ts";
import { dispatchTopic } from "./push-dispatch.ts";
import { getTopic } from "./push-topics.ts";
import { ulid } from "./ulid.ts";
import { routeFrameSpan } from "./otel.ts";

const RING_BUFFER_SIZE = 200;
const DEFAULT_OFFLINE_PUSH_DELAY_MS = 30_000;

interface DaemonState {
  daemon_id: string;
  hostname: string;
  display_name: string | null;
  epoch: number;
  sessions: Map<string, SessionSnapshot>;
  events: EventFrameForPwa[];
  // In-flight AskUserQuestion requests keyed on request_id. The daemon's hook
  // owns the authoritative timer; this cache exists so a refreshed PWA can
  // re-render the picker without us asking the daemon to re-emit. Replayed
  // on PWA subscribe; cleared when ask_user_question_resolved arrives or the
  // daemon disconnects.
  pendingAskQuestions: Map<string, PwaAskUserQuestionRequest>;
  // Latest slash_inventory per session_id. The daemon emits it once when a
  // session registers; we cache it so a PWA that connects later (or
  // refreshes) still sees commands. Cleared on session_close / daemon
  // disconnect.
  slashInventory: Map<string, SlashEntry[]>;
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

  public getConnectedDaemonIds(): Set<string> {
    return new Set(this.daemons.keys());
  }

  public closeDaemonConnection(daemon_id: string): void {
    if (!this.daemons.has(daemon_id)) return;
    const ws = this.daemonReg.getWs(daemon_id) as { close?: (code?: number, reason?: string) => void } | undefined;
    if (ws && typeof ws.close === "function") {
      ws.close(1008, "revoked");
    }
  }

  onDaemonFrame(daemon_id: string, frame: DaemonToHub): void {
    switch (frame.type) {
      case "hello": {
        // Cancel any pending offline-push timer for this daemon.
        const t = this.offlineTimers.get(daemon_id);
        if (t) { clearTimeout(t); this.offlineTimers.delete(daemon_id); }
        this.offlineMeta.delete(daemon_id);

        let display_name: string | null = null;
        if (this.db) {
          display_name = findDaemon(this.db, daemon_id)?.display_name ?? null;
        }

        const state: DaemonState = {
          daemon_id,
          hostname: frame.hostname,
          display_name,
          epoch: frame.epoch,
          sessions: new Map(frame.sessions.map((s) => [s.session_id, s])),
          events: [],
          pendingAskQuestions: new Map(),
          slashInventory: new Map(),
        };
        this.daemons.set(daemon_id, state);
        this.pwaReg.broadcast({
          type: "daemon_online", daemon_id, hostname: frame.hostname, display_name, sessions: frame.sessions,
        });
        return;
      }
      case "session_open": {
        const state = this.daemons.get(daemon_id);
        if (!state) return;
        state.sessions.set(frame.session.session_id, frame.session);
        this.pwaReg.broadcast({
          type: "session_open",
          daemon_id,
          session: frame.session,
          ...(frame.request_id !== undefined ? { request_id: frame.request_id } : {}),
        });
        return;
      }
      case "session_close": {
        const state = this.daemons.get(daemon_id);
        if (!state) return;
        state.sessions.delete(frame.session_id);
        state.slashInventory.delete(frame.session_id);
        this.pwaReg.broadcast({ type: "session_close", daemon_id, session_id: frame.session_id, reason: frame.reason });
        return;
      }
      case "event": {
        const state = this.daemons.get(daemon_id);
        if (!state) return;
        routeFrameSpan(
          frame.trace,
          { frame_type: "event", daemon_id, session_id: frame.session_id },
          (outboundTrace) => {
            const out: EventFrameForPwa = {
              type: "event", daemon_id,
              session_id: frame.session_id, jsonl_offset: frame.jsonl_offset,
              payload: frame.payload,
              ...(outboundTrace ? { trace: outboundTrace } : (frame.trace ? { trace: frame.trace } : {})),
            };
            state.events.push(out);
            if (state.events.length > RING_BUFFER_SIZE) state.events.shift();
            this.pwaReg.broadcast(out);
          },
        );
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
        if (this.db && this.push) void dispatchTopic(this.db, this.push, getTopic("permission"), daemon_id, {
          daemon_id,
          session_id: frame.session_id,
          request_id: frame.request_id,
          tool: frame.tool,
          args_summary: frame.args_summary,
        });
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
      case "ask_user_question_request": {
        const state = this.daemons.get(daemon_id);
        if (!state) return;
        const out: PwaAskUserQuestionRequest = {
          type: "ask_user_question_request", daemon_id,
          session_id: frame.session_id, request_id: frame.request_id,
          questions: frame.questions, expires_at: frame.expires_at,
        };
        state.pendingAskQuestions.set(frame.request_id, out);
        this.pwaReg.broadcast(out);
        return;
      }
      case "ask_user_question_resolved": {
        const state = this.daemons.get(daemon_id);
        if (!state) return;
        state.pendingAskQuestions.delete(frame.request_id);
        this.pwaReg.broadcast({
          type: "ask_user_question_resolved", daemon_id,
          session_id: frame.session_id, request_id: frame.request_id,
          resolution: frame.resolution,
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
        if (this.db && this.push) void dispatchTopic(this.db, this.push, getTopic("completed"), daemon_id, {
          daemon_id, session_id: frame.session_id,
        });
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
        if (this.db && this.push) void dispatchTopic(this.db, this.push, getTopic("idle"), daemon_id, {
          daemon_id, session_id: frame.session_id,
        });
        return;
      }
      case "session_state": {
        const state = this.daemons.get(daemon_id);
        if (!state) return;
        const s = state.sessions.get(frame.session_id);
        if (s) state.sessions.set(frame.session_id, { ...s, state: frame.state });
        this.pwaReg.broadcast({
          type: "session_state",
          daemon_id,
          session_id: frame.session_id,
          state: frame.state,
          prev: frame.prev,
          ts: frame.ts,
        });
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
      case "start_session_rejected": {
        const state = this.daemons.get(daemon_id);
        if (!state) return;
        this.pwaReg.broadcast({
          type: "start_session_rejected",
          daemon_id,
          request_id: frame.request_id,
          cwd: frame.cwd,
          reason: frame.reason,
          message: frame.message,
        });
        return;
      }
      case "slash_inventory": {
        const state = this.daemons.get(daemon_id);
        if (!state) return;
        state.slashInventory.set(frame.session_id, frame.entries);
        this.pwaReg.broadcast({
          type: "slash_inventory",
          daemon_id,
          session_id: frame.session_id,
          entries: frame.entries,
        });
        return;
      }
      case "session_rebound": {
        const state = this.daemons.get(daemon_id);
        if (!state) return;
        // Drop cached events for the session — they belong to the previous
        // claude_session_id and shouldn't be served to a PWA that subscribes
        // post-rebind. Untouched events for other sessions stay.
        state.events = state.events.filter(
          (e) => e.session_id !== frame.session_id,
        );
        this.pwaReg.broadcast({
          type: "session_rebound",
          daemon_id,
          session_id: frame.session_id,
          claude_session_id: frame.claude_session_id,
        });
        return;
      }
    }
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
      const since_ms = Date.now() - meta.disconnected_at;
      if (this.db && this.push) {
        void dispatchTopic(this.db, this.push, getTopic("offline"), daemon_id, {
          daemon_id, hostname: meta.hostname, since_ms,
        });
      }
    }, this.offlinePushDelayMs);
    // Don't keep the event loop alive just for this timer.
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
    this.offlineTimers.set(daemon_id, timer);
  }

  onPwaSubscribe(send: (f: HubToPwa) => void): void {
    send({ type: "snapshot", daemons: this.snapshot() });
    for (const d of this.daemons.values()) {
      for (const q of d.pendingAskQuestions.values()) send(q);
      for (const [session_id, entries] of d.slashInventory) {
        const f: PwaSlashInventory = {
          type: "slash_inventory",
          daemon_id: d.daemon_id,
          session_id,
          entries,
        };
        send(f);
      }
    }
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
      if (frame.request_id !== undefined) out.request_id = frame.request_id;
      this.daemonReg.send(frame.daemon_id, out);
    } else if (frame.type === "ask_user_question_answer") {
      this.daemonReg.send(frame.daemon_id, {
        type: "ask_user_question_answer",
        session_id: frame.session_id,
        request_id: frame.request_id,
        answers: frame.answers,
      });
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
    routeFrameSpan(
      frame.trace,
      { frame_type: "chat_send", daemon_id: frame.daemon_id, session_id: frame.session_id },
      (outboundTrace) => {
        const message_id = ulid();
        const ts = Math.floor(Date.now() / 1000);
        const reply_to = frame.reply_to ?? null;

        if (!this.daemonReg.has(frame.daemon_id)) {
          const errOut: HubChatErrorBroadcast = {
            type: "chat_error",
            daemon_id: frame.daemon_id,
            session_id: frame.session_id,
            reason: "daemon_offline",
            ...(frame.client_message_id !== undefined ? { client_message_id: frame.client_message_id } : {}),
          };
          senderSend(errOut);
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
          ...(outboundTrace ? { trace: outboundTrace } : {}),
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
          ...(frame.client_message_id !== undefined ? { client_message_id: frame.client_message_id } : {}),
          ...(outboundTrace ? { trace: outboundTrace } : {}),
        });
      },
    );
  }

  onPwaCliCommand(
    frame: PwaToHubCliCommand,
    auth: { user: string; user_id: string },
  ): void {
    if (!this.daemonReg.has(frame.daemon_id)) {
      // No live daemon connection — silently drop. PWA can re-emit later.
      return;
    }
    const out: HubToDaemonCliCommand = {
      type: "cli_command",
      session_id: frame.session_id,
      text: frame.text,
      user: auth.user,
    };
    this.daemonReg.send(frame.daemon_id, out);
  }

  snapshot(): DaemonView[] {
    return [...this.daemons.values()].map((d) => ({
      daemon_id: d.daemon_id, hostname: d.hostname, display_name: d.display_name, online: true,
      sessions: [...d.sessions.values()],
    }));
  }

  /**
   * Update in-memory display_name (if daemon is connected) and broadcast
   * a daemon_renamed frame to all PWAs. Called from the rename HTTP route
   * after a successful DB write so connected PWAs reflect the new name
   * without polling.
   */
  onDaemonRenamed(daemon_id: string, display_name: string | null): void {
    const state = this.daemons.get(daemon_id);
    if (state) state.display_name = display_name;
    this.pwaReg.broadcast({ type: "daemon_renamed", daemon_id, display_name });
  }

  bufferOf(daemon_id: string): EventFrameForPwa[] {
    return this.daemons.get(daemon_id)?.events ?? [];
  }
}
