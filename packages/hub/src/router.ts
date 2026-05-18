import type { DaemonToHub, HubToPwa, SessionSnapshot, DaemonView, EventFrameForPwa } from "@cc-remote/proto";
import type { DaemonRegistry, PwaRegistry } from "./connections.ts";

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
      case "permission_request":
        return; // wired in P4-T4
      case "permission_resolved":
        return; // wired in P4-T4
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

  onDaemonDisconnect(daemon_id: string): void {
    if (!this.daemons.has(daemon_id)) return;
    this.daemons.delete(daemon_id);
    this.pwaReg.broadcast({ type: "daemon_offline", daemon_id });
  }

  onPwaSubscribe(send: (f: HubToPwa) => void): void {
    send({ type: "snapshot", daemons: this.snapshot() });
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
