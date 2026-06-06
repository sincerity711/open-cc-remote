import type { AGUIEvent } from "./agui/events";

// Subset of frames implemented in Plan 1.
// Auth, permission, history, file-transfer frames come in later plans.

/**
 * W3C Trace Context, embedded as an optional field on frames that
 * trigger downstream work. Receivers extract it to continue the
 * round-trip's trace; emitters of follow-up notifications inject the
 * context they collected by joining on session_id (see daemon's
 * SessionMap). Field is fully optional — when absent, downstream
 * starts a fresh root span.
 */
export interface TraceCtx {
  traceparent: string;
  tracestate?: string;
}

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
  | PluginChatOut
  | HookAskUserQuestionRequest;

export type DaemonToPlugin =
  | { type: "ack"; ref: "register" | "bye" | "chat_out" }
  | { type: "daemon_going_down"; reason: "shutdown" | "restart" }
  | DaemonBindResolved
  | PluginPermissionReply
  | DaemonChatIn
  | HookAskUserQuestionAnswer;

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
  /** W3C trace ctx — daemon attaches via SessionMap when an active
   *  round-trip exists for this session. Optional. */
  trace?: TraceCtx;
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
  | { type: "ping"; ts: number }
  | EventFrame
  | DaemonPermissionRequest
  | DaemonPermissionResolved
  | DaemonHistoryChunk
  | TaskCompletedFrame
  | IdleFrame
  | SessionStateFrame
  | DaemonStartSessionRejected
  | PluginChatOut
  | DaemonAskUserQuestionRequest
  | DaemonAskUserQuestionResolved
  | DaemonSlashInventory
  | DaemonAgentHandshake
  | DaemonSessionRebound
  | DaemonFsListResult;

export type HubToDaemon =
  | { type: "pong"; ts: number }
  | HubPermissionReply
  | HubToDaemonRequestHistory
  | HubToDaemonKillSession
  | HubToDaemonStartSession
  | HubToDaemonChatSend
  | HubAskUserQuestionAnswer
  | HubToDaemonCliCommand
  | HubToDaemonFsList;

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
  | { type: "pong"; ts: number }
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
  | PwaAskUserQuestionRequest
  | PwaAskUserQuestionResolved
  | PwaSlashInventory
  | PwaAgentHandshake
  | PwaSessionRebound
  | PwaFsListResult;

export type PwaToHub =
  | { type: "subscribe" }  // Plan 1 PWA only subscribes; commands come in Plan 4
  | { type: "ping"; ts: number }
  | PwaToHubPermissionReply
  | PwaToHubRequestHistory
  | PwaToHubKillSession
  | PwaToHubStartSession
  | PwaToHubChatSend
  | PwaToHubAskUserQuestionAnswer
  | PwaToHubCliCommand
  | PwaToHubFsList;

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
  /** W3C trace context — plumbed from hub via daemon for span continuity. */
  trace?: TraceCtx;
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
  /** Optional W3C trace context — populated when PWA-side OTel is on. */
  trace?: TraceCtx;
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
  /** Forwarded W3C trace context. */
  trace?: TraceCtx;
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
  /** W3C trace context — set by the daemon when emitting (joined to the
   *  round-trip root via SessionMap). */
  trace?: TraceCtx;
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

/**
 * @deprecated Use `agent_handshake.available_commands` instead. This frame is
 * kept for backwards compatibility while clients migrate; the handshake frame
 * carries the same `SlashEntry[]` plus version/modes/capability metadata.
 */
export interface DaemonSlashInventory {
  type: "slash_inventory";
  session_id: string;
  entries: SlashEntry[];
}

/**
 * @deprecated Use `agent_handshake.available_commands` instead.
 */
export interface PwaSlashInventory {
  type: "slash_inventory";
  daemon_id: string;
  session_id: string;
  entries: SlashEntry[];
}

// ─── agent_handshake (Task #3 AionUi-borrow) ──────────────────────────
//
// Once-per-session capability advertisement: agent version, available
// permission modes (parsed from `claude --help`), default mode (from
// `~/.claude/settings.json`), available models (hardcoded — CC has no
// static list), the slash command inventory (same payload as the legacy
// `slash_inventory` frame), and runtime capability bits keyed off CC
// version. See docs/superpowers/specs/2026-06-07-agent-handshake-design.md.
export interface AgentCapabilityBits {
  /** CC ≥2.1.146 — daemon may install a Notification hook. */
  supports_notification_hook: boolean;
  /** CC ≥2.1.150 — daemon-side ack semantics work. */
  supports_ack: boolean;
  /** CC ≥2.1.139 — jsonl writer flushes promptly (older versions buffered). */
  jsonl_flush_quirk: boolean;
  /** Always true for CC ≥2.0; explicit so future agents can flip it. */
  has_mcp: boolean;
  /** `--plugin-dir` flag is present in 2.1.x; hardcoded true for now. */
  has_plugin: boolean;
}

export interface DaemonAgentHandshake {
  type: "agent_handshake";
  session_id: string;
  /** null when `claude` binary missing or `--version` parse failed. */
  agent_version: string | null;
  /**
   * Parsed from `claude --help` (`--permission-mode` choices). Falls back
   * to a hardcoded list when parse fails; empty only when the binary is
   * missing — UI degrades gracefully.
   */
  available_modes: string[];
  /**
   * From settings.json `permissions.defaultMode`. Project setting (in
   * `<cwd>/.claude/settings.json`) overrides user setting (`~/.claude`).
   */
  default_mode: string | null;
  /**
   * Hardcoded `["sonnet","opus","haiku"]`. CC has no `--list-models` flag,
   * model is a runtime `--model` argument; revisit if such a flag ships.
   */
  available_models: string[];
  /** Same payload as the legacy `slash_inventory` frame. */
  available_commands: SlashEntry[];
  capabilities: AgentCapabilityBits;
}

export interface PwaAgentHandshake {
  type: "agent_handshake";
  daemon_id: string;
  session_id: string;
  agent_version: string | null;
  available_modes: string[];
  default_mode: string | null;
  available_models: string[];
  available_commands: SlashEntry[];
  capabilities: AgentCapabilityBits;
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

// ─── session_rebound (CC /clear or /resume creates a new jsonl) ───────

/** Daemon noticed a new jsonl appeared in this session's projects dir
 *  (typically after CC `/clear` or `--resume`). The daemon has stopped the
 *  watcher on the old file and is now reading from the new claude_session_id.
 *  The old conversation events are no longer authoritative — PWA should
 *  drop cached timeline state and start fresh from the next event/history. */
export interface DaemonSessionRebound {
  type: "session_rebound";
  session_id: string;
  claude_session_id: string;
}

export interface PwaSessionRebound {
  type: "session_rebound";
  daemon_id: string;
  session_id: string;
  claude_session_id: string;
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

// ─── filesystem listing (folder/path autocomplete) ───────────────────
//
// PWA path-autocomplete UIs (cwd picker on the home screen, @-mention
// popover in the chat composer) need to discover the daemon host's
// directory tree on demand. The daemon enforces a whitelist
// ($HOME ∪ CC_REMOTE_FS_ROOTS) so the PWA — and anyone able to send
// frames at the hub — can never list arbitrary host paths.
//
// `request_id` is round-tripped end-to-end so multiple inflight
// completions (e.g. user typing fast across two parents) can be
// disambiguated on the PWA side.

export interface PwaToHubFsList {
  type: "fs_list";
  daemon_id: string;
  request_id: string;
  /** Absolute path to list. `~/...` and trailing-slash forms allowed; daemon resolves. */
  path: string;
  trace?: TraceCtx;
}

export interface HubToDaemonFsList {
  type: "fs_list";
  request_id: string;
  path: string;
  trace?: TraceCtx;
}

export interface FsListEntry {
  name: string;
  is_dir: boolean;
}

export type FsListErrorCode = "forbidden" | "not_found" | "io";

export interface DaemonFsListResult {
  type: "fs_list_result";
  request_id: string;
  ok: boolean;
  /** Resolved absolute path actually listed (post `~` / `..` normalisation). */
  path?: string;
  entries?: FsListEntry[];
  error?: FsListErrorCode;
}

export interface PwaFsListResult {
  type: "fs_list_result";
  daemon_id: string;
  request_id: string;
  ok: boolean;
  path?: string;
  entries?: FsListEntry[];
  error?: FsListErrorCode;
}
