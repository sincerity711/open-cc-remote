import type { AGUIEvent } from "./agui/events";

// Subset of frames implemented in Plan 1.
// Auth, permission, history, file-transfer frames come in later plans.

/**
 * Daemon-owned session state machine. Source of truth: JSONL events +
 * permission protocol. The daemon classifies; hub forwards; PWA renders.
 *
 * Transitions (see packages/daemon/src/session-fsm.ts):
 *   register                                    → idle
 *   jsonl line (any type, !waiting)             → working
 *   assistant end_turn → idle_window elapsed    → idle
 *   permission_request                          → waiting (push prev)
 *   permission_resolved (last pending)          → pop prev
 *   session_close                               → (removed)
 *
 * "offline" is NOT a session-FSM state — it's derived in the PWA from
 * !daemon.online (the daemon process can't classify itself as offline).
 */
export type SessionState = "working" | "waiting" | "idle";

// Plugin-issued routing key (UUID generated at plugin startup) plus
// derived metadata. claude_session_id is null until the daemon's JSONL
// bind algorithm resolves it (see packages/daemon/src/jsonl-bind.ts).
export interface SessionSnapshot {
  session_id: string;                   // plugin-issued UUID, stable for life of session
  claude_session_id: string | null;     // resolved from JSONL filename post-bind
  tmux_session: string | null;
  tmux_pane: string | null;
  cwd: string;
  model: string | null;                 // null until enriched from JSONL header (future)
  pid: number;
  started_at: number;                   // unix seconds
  claude_client_version: string;        // from MCP initialize.clientInfo.version
  plugin_version: string;               // from packages/plugin/package.json
  /**
   * Current FSM state (daemon-owned). Carried on snapshot / session_open so
   * the PWA recovers the latest state across reconnect; live transitions
   * arrive as SessionStateFrame.
   */
  state: SessionState;
}

// ─── plugin ↔ daemon (Unix socket) ────────────────────────────────────

export type PluginToDaemon =
  | { type: "register"; session: SessionSnapshot }
  | { type: "bye"; session_id: string }
  | PluginPermissionRequest
  | PluginChatOut;

export type DaemonToPlugin =
  | { type: "ack"; ref: "register" | "bye" | "chat_out" }
  | { type: "daemon_going_down"; reason: "shutdown" | "restart" }
  | DaemonBindResolved
  | PluginPermissionReply
  | DaemonChatIn;

/**
 * Daemon → plugin notification: we resolved the JSONL filename and now know
 * `claude_session_id`. Plugin caches this so a re-register after daemon
 * restart can carry the resolved id and let the daemon skip bindJsonl on
 * the second register (which historically broke when the file's mtime was
 * outside the bind pre-scan window).
 */
export interface DaemonBindResolved {
  type: "bind_resolved";
  session_id: string;
  claude_session_id: string;
}

// ─── daemon ↔ hub (WSS) ───────────────────────────────────────────────

// Real-time event from a session's JSONL file. Daemon emits these as new lines
// appear; hub fans them out to PWAs (with daemon_id added). Payload is opaque
// (the parsed JSONL line) to keep daemon decoupled from Claude Code's schema.
//
// No envelope-level `ts`: the frame represents "daemon read a JSONL line"
// (which is meaningless on JSONL replay after a daemon restart). The actual
// event time is on each AG-UI event's `timestamp` field — populated by the
// adapter from the JSONL row's `timestamp` (claude-code's own write time).
export interface EventFrame {
  type: "event";
  session_id: string;
  jsonl_offset: number;     // byte offset *after* this line in the JSONL file
  payload: AGUIEvent[];     // post-adapter; one source row → N AG-UI events
}

export interface EventFrameForPwa extends EventFrame {
  daemon_id: string;        // hub adds this when forwarding to PWA
}

export interface DaemonSessionOpenFrame {
  type: "session_open";
  session: SessionSnapshot;
  /** Present when this session was spawned in response to a PWA start_session
   *  command; absent for plugin-driven registrations. */
  request_id?: string;
}

export interface PwaSessionOpenFrame {
  type: "session_open";
  daemon_id: string;
  session: SessionSnapshot;
  /** Forwarded verbatim from the daemon. Present for PWA-originated starts. */
  request_id?: string;
}

export type DaemonToHub =
  | { type: "hello"; daemon_id: string; epoch: number; hostname: string; agent_version: string; sessions: SessionSnapshot[] }
  | DaemonSessionOpenFrame
  | { type: "session_close"; session_id: string; reason: string }
  | { type: "pong"; ts: number }
  | EventFrame
  | DaemonPermissionRequest
  | DaemonPermissionResolved
  | DaemonHistoryChunk
  | TaskCompletedFrame
  | IdleFrame
  | SessionStateFrame
  | DaemonStartSessionRejected
  | PluginChatOut
  | DaemonSlashInventory;

export type HubToDaemon =
  | { type: "ping"; ts: number }
  | HubPermissionReply
  | HubToDaemonRequestHistory
  | HubToDaemonKillSession
  | HubToDaemonStartSession
  | HubToDaemonChatSend
  | HubToDaemonCliCommand;

// ─── hub ↔ PWA (WSS) ──────────────────────────────────────────────────

export interface DaemonView {
  daemon_id: string;
  hostname: string;
  display_name: string | null;
  online: boolean;
  sessions: SessionSnapshot[];
}

export type HubToPwa =
  | { type: "snapshot"; daemons: DaemonView[] }
  | { type: "daemon_online"; daemon_id: string; hostname: string; display_name: string | null; sessions: SessionSnapshot[] }
  | { type: "daemon_offline"; daemon_id: string }
  | { type: "daemon_renamed"; daemon_id: string; display_name: string | null }
  | PwaSessionOpenFrame
  | { type: "session_close"; daemon_id: string; session_id: string; reason: string }
  | EventFrameForPwa
  | PwaPermissionRequest
  | PwaPermissionResolved
  | PwaHistoryChunk
  | PwaTaskCompletedFrame
  | PwaIdleFrame
  | PwaSessionStateFrame
  | PwaStartSessionRejected
  | PwaChatBroadcast
  | HubChatErrorBroadcast
  | PwaSlashInventory;

export type PwaToHub =
  | { type: "subscribe" }  // Plan 1 PWA only subscribes; commands come in Plan 4
  | PwaToHubPermissionReply
  | PwaToHubRequestHistory
  | PwaToHubKillSession
  | PwaToHubStartSession
  | PwaToHubChatSend
  | PwaToHubCliCommand;

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
  /**
   * Optional client-generated id so the daemon's reject frame can be
   * correlated back to the originating PWA request. Echoed verbatim by
   * the hub on forward and by the daemon on rejection.
   */
  request_id?: string;
}

export interface HubToDaemonStartSession {
  type: "start_session";
  cwd: string;
  name?: string;
  request_id?: string;
}

/**
 * Daemon → hub when a start_session request is rejected (allow_start=false,
 * cwd outside allowed_cwd_prefix, mkdir/spawn failure, spawn_command unset).
 * Hub forwards to all PWAs as PwaStartSessionRejected so the originating
 * client can show an inline error / toast.
 */
export type StartSessionRejectReason =
  | "not_allowed"          // allow_start=false
  | "cwd_not_allowed"      // outside allowed_cwd_prefix
  | "spawn_command_unset"  // config has no spawn_command
  | "mkdir_failed"         // could not create cwd
  | "spawn_failed";        // tmux/exec call threw

export interface DaemonStartSessionRejected {
  type: "start_session_rejected";
  request_id: string | null;
  cwd: string;
  reason: StartSessionRejectReason;
  message: string;
}

export interface PwaStartSessionRejected {
  type: "start_session_rejected";
  daemon_id: string;
  request_id: string | null;
  cwd: string;
  reason: StartSessionRejectReason;
  message: string;
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
  payload: AGUIEvent[];     // post-adapter; one source row → N AG-UI events
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

// ─── chat (PWA ↔ Claude via plugin) ───────────────────────────────────

export interface PluginChatOut {
  type: "chat_out";
  session_id: string;          // plugin_session_id
  content: string;
  ts: number;                  // unix seconds
  reply_to: string | null;
}

export interface DaemonChatIn {
  type: "chat_in";
  session_id: string;          // plugin_session_id
  message_id: string;          // ULID-style for reply_to threading
  user: string;                // PWA bearer subject (email)
  user_id: string;             // PWA bearer sub claim
  content: string;
  ts: number;
}

// PWA → Hub
export interface PwaToHubChatSend {
  type: "chat_send";
  daemon_id: string;
  session_id: string;
  content: string;
  reply_to?: string;
  /**
   * PWA-generated id used to correlate the resulting `chat` broadcast (or
   * `chat_error`) back to this send. Echoed verbatim by the hub.
   */
  client_message_id?: string;
}

// Hub → Daemon
export interface HubToDaemonChatSend {
  type: "chat_send";
  session_id: string;
  message_id: string;          // ULID, hub-generated
  user: string;                // bearer subject (email)
  user_id: string;             // bearer sub claim
  content: string;
  reply_to: string | null;
  ts: number;                  // unix seconds
}

// Hub → PWA (broadcast)
export interface PwaChatBroadcast {
  type: "chat";
  daemon_id: string;
  session_id: string;
  message_id: string;
  from: "pwa" | "claude";
  user: string | null;          // populated when from = "pwa"
  content: string;
  reply_to: string | null;
  ts: number;
  /** Echoed when this broadcast originated from a PWA chat_send. Absent for
   *  Claude-originated messages. */
  client_message_id?: string;
}

// Hub → PWA (chat error, e.g. daemon offline)
export interface HubChatErrorBroadcast {
  type: "chat_error";
  daemon_id: string;
  session_id: string;
  reason: string;
  /** Present when the error is bound to a specific PWA chat_send. */
  client_message_id?: string;
}

// ─── slash inventory + cli_command (PWA `/` helper) ───────────────────

export interface SlashEntry {
  /** Stable id within this session — `<source>:<basename>` (basename has no
   *  leading "/"). React key + selection target. */
  id: string;
  /** Includes the leading "/", e.g. "/clear", "/brainstorming". */
  name: string;
  description?: string;
  argument_hint?: string;
  source: "builtin" | "user" | "project" | "skill";
}

export interface DaemonSlashInventory {
  type: "slash_inventory";
  session_id: string;
  entries: SlashEntry[];
}

export interface PwaSlashInventory {
  type: "slash_inventory";
  daemon_id: string;
  session_id: string;
  entries: SlashEntry[];
}

export interface PwaToHubCliCommand {
  type: "cli_command";
  daemon_id: string;
  session_id: string;
  /** Verbatim string to inject (with leading "/"), e.g. "/brainstorming todo". */
  text: string;
}

export interface HubToDaemonCliCommand {
  type: "cli_command";
  session_id: string;
  text: string;
  /** Bearer subject of the PWA user, for daemon log audit. */
  user: string;
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

// ─── idle (Claude waiting for user input) ─────────────────────────────

export interface IdleFrame {
  type: "idle";
  session_id: string;
  ts: number;
}

export interface PwaIdleFrame {
  type: "idle";
  daemon_id: string;
  session_id: string;
  ts: number;
}

// ─── session_state (FSM transitions) ──────────────────────────────────
//
// Emitted by the daemon on every session-FSM transition. Hub forwards to
// PWA verbatim (with daemon_id added) and updates its cached SessionSnapshot
// so reconnecting PWAs see the latest state via the snapshot path.

export interface SessionStateFrame {
  type: "session_state";
  session_id: string;
  state: SessionState;
  prev: SessionState;
  ts: number;
}

export interface PwaSessionStateFrame {
  type: "session_state";
  daemon_id: string;
  session_id: string;
  state: SessionState;
  prev: SessionState;
  ts: number;
}

// ─── ask_user_question relay ──────────────────────────────────────────
//
// Workaround for the missing channel notification (anthropics/claude-code
// #59245). Trigger path is a local PreToolUse hook on AskUserQuestion that
// connects to the daemon socket; protocol shape mirrors permission_request
// so the PWA can reuse the same surface idiom.
//
// When upstream ships `notifications/claude/channel/ask_question_request`,
// only the `HookToDaemon*` entry path needs to move from socket → plugin;
// daemon/hub/PWA frames can stay as-is.

export interface AskUserQuestionItem {
  question: string;
  header: string;
  multiSelect: boolean;
  options: { label: string; description?: string }[];
}

// Hook (over Unix socket) → daemon
export interface HookAskUserQuestionRequest {
  type: "ask_user_question_request";
  /** CC session_id from hook stdin == claude_session_id (daemon resolves to plugin_session_id) */
  claude_session_id: string;
  request_id: string;
  questions: AskUserQuestionItem[];
  expires_at: number;
}

// Hook ← daemon (over the same Unix socket connection)
export interface HookAskUserQuestionAnswer {
  type: "ask_user_question_answer";
  request_id: string;
  /** answers[i] corresponds to questions[i]; null = "Other"/timeout fallback. */
  answers: (string | null)[];
  resolution: "answered" | "expired" | "session_unknown" | "no_pwa";
}

// Daemon → hub
export interface DaemonAskUserQuestionRequest {
  type: "ask_user_question_request";
  session_id: string;
  request_id: string;
  questions: AskUserQuestionItem[];
  expires_at: number;
}

export interface DaemonAskUserQuestionResolved {
  type: "ask_user_question_resolved";
  session_id: string;
  request_id: string;
  resolution: "answered" | "expired" | "session_unknown" | "no_pwa";
}

// Hub → PWA
export interface PwaAskUserQuestionRequest {
  type: "ask_user_question_request";
  daemon_id: string;
  session_id: string;
  request_id: string;
  questions: AskUserQuestionItem[];
  expires_at: number;
}

export interface PwaAskUserQuestionResolved {
  type: "ask_user_question_resolved";
  daemon_id: string;
  session_id: string;
  request_id: string;
  resolution: "answered" | "expired" | "session_unknown" | "no_pwa";
}

// PWA → Hub
export interface PwaToHubAskUserQuestionAnswer {
  type: "ask_user_question_answer";
  daemon_id: string;
  session_id: string;
  request_id: string;
  answers: (string | null)[];
}

// Hub → daemon
export interface HubAskUserQuestionAnswer {
  type: "ask_user_question_answer";
  session_id: string;
  request_id: string;
  answers: (string | null)[];
}
