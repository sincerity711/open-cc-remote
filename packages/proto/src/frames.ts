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

// Real-time event from a session's JSONL file. Daemon emits these as new lines
// appear; hub fans them out to PWAs (with daemon_id added). Payload is opaque
// (the parsed JSONL line) to keep daemon decoupled from Claude Code's schema.
export interface EventFrame {
  type: "event";
  session_id: string;
  jsonl_offset: number;     // byte offset *after* this line in the JSONL file
  ts: number;               // ms epoch when daemon read it
  payload: unknown;         // raw parsed JSONL line
}

export interface EventFrameForPwa extends EventFrame {
  daemon_id: string;        // hub adds this when forwarding to PWA
}

export type DaemonToHub =
  | { type: "hello"; daemon_id: string; epoch: number; hostname: string; agent_version: string; sessions: SessionSnapshot[] }
  | { type: "session_open"; session: SessionSnapshot }
  | { type: "session_close"; session_id: string; reason: string }
  | { type: "pong"; ts: number }
  | EventFrame;

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
  | { type: "session_close"; daemon_id: string; session_id: string; reason: string }
  | EventFrameForPwa;

export type PwaToHub =
  | { type: "subscribe" };  // Plan 1 PWA only subscribes; commands come in Plan 4
