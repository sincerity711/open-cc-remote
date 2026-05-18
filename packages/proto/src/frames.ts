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
  | { type: "bye"; session_id: string }
  | PluginPermissionRequest;

export type DaemonToPlugin =
  | { type: "ack"; ref: "register" | "bye" }
  | PluginPermissionReply;

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
  | EventFrame
  | DaemonPermissionRequest
  | DaemonPermissionResolved
  | DaemonHistoryChunk
  | TaskCompletedFrame;

export type HubToDaemon =
  | { type: "ping"; ts: number }
  | HubPermissionReply
  | HubToDaemonRequestHistory
  | HubToDaemonKillSession
  | HubToDaemonStartSession;

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
  | EventFrameForPwa
  | PwaPermissionRequest
  | PwaPermissionResolved
  | PwaHistoryChunk
  | PwaTaskCompletedFrame;

export type PwaToHub =
  | { type: "subscribe" }  // Plan 1 PWA only subscribes; commands come in Plan 4
  | PwaToHubPermissionReply
  | PwaToHubRequestHistory
  | PwaToHubKillSession
  | PwaToHubStartSession;

// ─── kill_session (dangerous action) ──────────────────────────────────

export interface PwaToHubKillSession {
  type: "kill_session";
  daemon_id: string;
  session_id: string;
}

export interface HubToDaemonKillSession {
  type: "kill_session";
  session_id: string;
}

// ─── start_session (dangerous action) ─────────────────────────────────

export interface PwaToHubStartSession {
  type: "start_session";
  daemon_id: string;
  cwd: string;
  name?: string;
}

export interface HubToDaemonStartSession {
  type: "start_session";
  cwd: string;
  name?: string;
}

// ─── history (scroll-back) ────────────────────────────────────────────

export interface PwaToHubRequestHistory {
  type: "request_history";
  daemon_id: string;
  session_id: string;
  request_id: string;
  before_offset: number;
  limit: number;
}

export interface HubToDaemonRequestHistory {
  type: "request_history";
  session_id: string;
  request_id: string;
  before_offset: number;
  limit: number;
}

export interface HistoryEvent {
  jsonl_offset: number;
  payload: unknown;
}

export interface DaemonHistoryChunk {
  type: "history_chunk";
  session_id: string;
  request_id: string;
  events: HistoryEvent[];
}

export interface PwaHistoryChunk {
  type: "history_chunk";
  daemon_id: string;
  session_id: string;
  request_id: string;
  events: HistoryEvent[];
}

// ─── permission relay ─────────────────────────────────────────────────

export interface PluginPermissionRequest {
  type: "permission_request";
  request_id: string;
  tool: string;
  args_summary: string;
  expires_at: number;
}

export interface PluginPermissionReply {
  type: "permission_reply";
  request_id: string;
  decision: "allow" | "deny";
}

export interface DaemonPermissionRequest {
  type: "permission_request";
  session_id: string;
  request_id: string;
  tool: string;
  args_summary: string;
  expires_at: number;
}

export interface DaemonPermissionResolved {
  type: "permission_resolved";
  session_id: string;
  request_id: string;
  decision: "allow" | "deny" | "expired" | "terminal";
  decided_via: string;
}

export interface HubPermissionReply {
  type: "permission_reply";
  session_id: string;
  request_id: string;
  decision: "allow" | "deny";
}

export interface PwaPermissionRequest {
  type: "permission_request";
  daemon_id: string;
  session_id: string;
  request_id: string;
  tool: string;
  args_summary: string;
  expires_at: number;
}

export interface PwaPermissionResolved {
  type: "permission_resolved";
  daemon_id: string;
  session_id: string;
  request_id: string;
  decision: "allow" | "deny" | "expired" | "terminal";
  decided_via: string;
}

export interface PwaToHubPermissionReply {
  type: "permission_reply";
  daemon_id: string;
  session_id: string;
  request_id: string;
  decision: "allow" | "deny";
}

// ─── task_completed (Claude finished a turn) ──────────────────────────

export interface TaskCompletedFrame {
  type: "task_completed";
  session_id: string;
  ts: number;
}

export interface PwaTaskCompletedFrame {
  type: "task_completed";
  daemon_id: string;
  session_id: string;
  ts: number;
}
