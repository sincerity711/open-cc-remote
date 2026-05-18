import type { DaemonToHub, HubToPwa, SessionSnapshot, DaemonView } from "@cc-remote/proto";
import type { DaemonRegistry, PwaRegistry } from "./connections.ts";

interface DaemonState {
  daemon_id: string;
  hostname: string;
  epoch: number;
  sessions: Map<string, SessionSnapshot>;
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
      case "event":
        return; // Plan 3 T5: fan-out to PWAs not yet implemented
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
}
