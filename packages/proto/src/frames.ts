// Subset of frames implemented in Plan 1.
// Auth, permission, history, file-transfer frames come in later plans.

export interface SessionSnapshot {
  session_id: string;
  tmux_session: string | null;
  tmux_pane: string | null;
  cwd: string;
  model: string;
  pid: number;
  started_at: number;
}

// ─── plugin ↔ daemon (Unix socket) ────────────────────────────────────

export type PluginToDaemon =
  | { type: "register"; session: SessionSnapshot }
  | { type: "bye"; session_id: string };

export type DaemonToPlugin =
  | { type: "ack"; ref: "register" | "bye" };

// ─── daemon ↔ hub (WSS) ───────────────────────────────────────────────

export type DaemonToHub =
  | { type: "hello"; daemon_id: string; epoch: number; hostname: string; agent_version: string; sessions: SessionSnapshot[] }
  | { type: "session_open"; session: SessionSnapshot }
  | { type: "session_close"; session_id: string; reason: string }
  | { type: "pong"; ts: number };

export type HubToDaemon =
  | { type: "ping"; ts: number };

// ─── hub ↔ PWA (WSS) ──────────────────────────────────────────────────

export interface DaemonView {
  daemon_id: string;
  hostname: string;
  online: boolean;
  sessions: SessionSnapshot[];
}

export type HubToPwa =
  | { type: "snapshot"; daemons: DaemonView[] }
  | { type: "daemon_online"; daemon_id: string; hostname: string; sessions: SessionSnapshot[] }
  | { type: "daemon_offline"; daemon_id: string }
  | { type: "session_open"; daemon_id: string; session: SessionSnapshot }
  | { type: "session_close"; daemon_id: string; session_id: string; reason: string };

export type PwaToHub =
  | { type: "subscribe" };  // Plan 1 PWA only subscribes; commands come in Plan 4
