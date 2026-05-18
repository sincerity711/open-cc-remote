import type { DaemonToHub, HubToPwa, SessionSnapshot, DaemonView, EventFrameForPwa, PwaToHub } from "@cc-remote/proto";
import type { DaemonRegistry, PwaRegistry } from "./connections.ts";
import type { Db } from "./db.ts";
import type { PushHelper } from "./push.ts";

const RING_BUFFER_SIZE = 200;

interface DaemonState {
  daemon_id: string;
  hostname: string;
  epoch: number;
  sessions: Map<string, SessionSnapshot>;
  events: EventFrameForPwa[];
}

export class Router {
  private daemons = new Map<string, DaemonState>();

  constructor(
    private daemonReg: DaemonRegistry<unknown>,
    private pwaReg: PwaRegistry<unknown>,
    private db?: Db,
    private push?: PushHelper,
  ) {}

  onDaemonFrame(daemon_id: string, frame: DaemonToHub): void {
    switch (frame.type) {
      case "hello": {
        const state: DaemonState = {
          daemon_id,
          hostname: frame.hostname,
          epoch: frame.epoch,
          sessions: new Map(frame.sessions.map((s) => [s.session_id, s])),
          events: [],
        };
        this.daemons.set(daemon_id, state);
        this.pwaReg.broadcast({
          type: "daemon_online",
          daemon_id,
          hostname: frame.hostname,
          sessions: frame.sessions,
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
        });
        return;
      }
      case "session_close": {
        const state = this.daemons.get(daemon_id);
        if (!state) return;
        state.sessions.delete(frame.session_id);
        this.pwaReg.broadcast({
          type: "session_close",
          daemon_id,
          session_id: frame.session_id,
          reason: frame.reason,
        });
        return;
      }
      case "pong":
        return; // Plan 1: heartbeat ignored
      case "permission_request": {
        const state = this.daemons.get(daemon_id);
        if (!state) return;
        this.pwaReg.broadcast({
          type: "permission_request",
          daemon_id,
          session_id: frame.session_id,
          request_id: frame.request_id,
          tool: frame.tool,
          args_summary: frame.args_summary,
          expires_at: frame.expires_at,
        });
        // Web Push fanout (best-effort).
        if (this.db && this.push) {
          void this.dispatchPush(daemon_id, frame);
        }
        return;
      }
      case "permission_resolved": {
        const state = this.daemons.get(daemon_id);
        if (!state) return;
        this.pwaReg.broadcast({
          type: "permission_resolved",
          daemon_id,
          session_id: frame.session_id,
          request_id: frame.request_id,
          decision: frame.decision,
          decided_via: frame.decided_via,
        });
        return;
      }
      case "history_chunk": {
        const state = this.daemons.get(daemon_id);
        if (!state) return;
        this.pwaReg.broadcast({
          type: "history_chunk",
          daemon_id,
          session_id: frame.session_id,
          request_id: frame.request_id,
          events: frame.events,
        });
        return;
      }
      case "event": {
        const state = this.daemons.get(daemon_id);
        if (!state) return;
        const out: EventFrameForPwa = {
          type: "event",
          daemon_id,
          session_id: frame.session_id,
          jsonl_offset: frame.jsonl_offset,
          ts: frame.ts,
          payload: frame.payload,
        };
        state.events.push(out);
        if (state.events.length > RING_BUFFER_SIZE) state.events.shift();
        this.pwaReg.broadcast(out);
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
      daemon_id,
      session_id: frame.session_id,
      request_id: frame.request_id,
      tool: frame.tool,
      args_summary: frame.args_summary,
    });
  }

  onDaemonDisconnect(daemon_id: string): void {
    if (!this.daemons.has(daemon_id)) return;
    this.daemons.delete(daemon_id);
    this.pwaReg.broadcast({ type: "daemon_offline", daemon_id });
  }

  onPwaSubscribe(send: (f: HubToPwa) => void): void {
    send({ type: "snapshot", daemons: this.snapshot() });
  }

  onPwaCommand(frame: PwaToHub): void {
    if (frame.type === "permission_reply") {
      this.daemonReg.send(frame.daemon_id, {
        type: "permission_reply",
        session_id: frame.session_id,
        request_id: frame.request_id,
        decision: frame.decision,
      });
    } else if (frame.type === "request_history") {
      this.daemonReg.send(frame.daemon_id, {
        type: "request_history",
        session_id: frame.session_id,
        request_id: frame.request_id,
        before_offset: frame.before_offset,
        limit: frame.limit,
      });
    }
    // "subscribe" is handled via onPwaSubscribe; ignore here.
  }

  snapshot(): DaemonView[] {
    return [...this.daemons.values()].map((d) => ({
      daemon_id: d.daemon_id,
      hostname: d.hostname,
      online: true,
      sessions: [...d.sessions.values()],
    }));
  }

  // Test/debug: read the in-memory ring buffer for a daemon (Plan 3 doesn't
  // expose this to PWAs yet, but tests use it to verify the buffer).
  bufferOf(daemon_id: string): EventFrameForPwa[] {
    return this.daemons.get(daemon_id)?.events ?? [];
  }
}
