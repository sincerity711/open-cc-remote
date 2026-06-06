import { useEffect, useRef, useState, useCallback } from "react";
import type {
  HubToPwa, PwaToHub, DaemonView, EventFrameForPwa, PwaPermissionRequest,
  PwaChatBroadcast, PwaStartSessionRejected, SessionState, AGUIEvent, SlashEntry,
  PwaAskUserQuestionRequest, PwaFsListResult, PwaAgentHandshake,
} from "@cc-remote/proto";
import {
  createPending, confirmPending, failPending, timeoutPending, dismissPending, findPending,
  type PendingCommand, type PendingCommands,
} from "./pendingCommands";
import { startUserSpan, recordRenderSpan } from "../otel/runtime";

export { type PendingCommand, type PendingCommands };

export const COMMAND_TIMEOUT_MS = 30_000;

function killCommandId(daemon_id: string, session_id: string): string {
  return `kill-${daemon_id}-${session_id}`;
}

/**
 * Drop all entries from `prev` for which `match` returns true.
 * Returns the original object (same reference) when nothing matches,
 * so callers can use identity equality to detect a no-op.
 */
function dropStalePending(
  prev: PendingCommands,
  match: (cmd: PendingCommand) => boolean,
): PendingCommands {
  const stale = Object.values(prev).filter(match);
  if (stale.length === 0) return prev;
  const next = { ...prev };
  for (const s of stale) delete next[s.id];
  return next;
}

const PER_SESSION_BUFFER = 2000;
const PER_SESSION_CHAT_BUFFER = 500;

/**
 * Flat record for a single AG-UI event within a JSONL row.
 * Keyed logically by (jsonl_offset, event_index) — each source row
 * produces N of these (one per element of EventFrame.payload[]).
 */
export interface BufferedEvent {
  daemon_id: string;
  session_id: string;
  jsonl_offset: number;
  event_index: number;       // position within the frame's payload[]
  ts: number;
  event: AGUIEvent;
}

/**
 * Append a live `event` frame to the per-session buffer, flattening
 * frame.payload[] into individual BufferedEvent records.
 * Dedup is idempotent by jsonl_offset: same row writes once.
 * Pure helper so it can be unit-tested independently of the React reducer.
 */
export function appendEventToBuffer(
  existing: BufferedEvent[],
  frame: EventFrameForPwa,
  max: number = PER_SESSION_BUFFER,
): BufferedEvent[] {
  // Idempotent dedup by jsonl_offset: same row writes once.
  if (existing.some((e) => e.jsonl_offset === frame.jsonl_offset)) return existing;
  const flat: BufferedEvent[] = frame.payload.map((event, event_index) => ({
    daemon_id: frame.daemon_id,
    session_id: frame.session_id,
    jsonl_offset: frame.jsonl_offset,
    event_index,
    // Time-of-event is the AG-UI event's `timestamp` (claude-code's write
    // time, parsed by the adapter from the JSONL row's `timestamp`). FSM
    // RUN_* markers and any non-JSONL synthetic events have no timestamp →
    // fall back to 0; mergeTimeline handles ts=0 by stable-sorting on
    // jsonl_offset so they don't get pinned to the epoch.
    ts: (event as { timestamp?: number }).timestamp ?? 0,
    event,
  }));
  const next = existing.concat(flat);
  return next.length > max ? next.slice(next.length - max) : next;
}

export interface HubState {
  connected: boolean;
  daemons: DaemonView[];
  events: Record<string, BufferedEvent[]>;
  pendingPermissions: Record<string, PwaPermissionRequest>;
  /**
   * Pending AskUserQuestion requests forwarded by the PreToolUse hook through
   * the daemon. Keyed by request_id. UI renders a card per pending request;
   * answering dispatches `outbound_ask_answer` and on `ask_user_question_resolved`
   * the entry is dropped.
   */
  pendingQuestions: Record<string, PwaAskUserQuestionRequest>;
  completedCounts: Record<string, number>;
  chatMessages: Record<string, PwaChatBroadcast[]>;
  chatErrors: Record<string, string>;  // keyed by eventKey, value = reason of last error
  /**
   * Most recent start_session_rejected frame, keyed by daemon_id. Surfaced
   * inline to the user at the daemon card / new-session form. Cleared by
   * the consumer after display (`clearStartSessionError`).
   */
  startSessionErrors: Record<string, PwaStartSessionRejected>;
  /**
   * Per-session flag: daemon has confirmed no more JSONL lines exist older
   * than the oldest known event. Set when a request_history returns 0 events.
   * UI uses this to hide the "Load earlier events" button.
   */
  noMoreHistory: Record<string, true>;
  /**
   * Pending outbound commands awaiting a server-side acknowledgement.
   * Keyed by client-generated id (e.g. client_message_id for chat_send).
   */
  pendingCommands: PendingCommands;
  /**
   * Slash command inventory pushed by the daemon after each session register,
   * keyed by `${daemon_id}::${session_id}`. Used by the composer's `/` menu.
   */
  slashInventory: Record<string, SlashEntry[]>;
  /**
   * Agent capability handshake (version, modes, default mode, models, slash
   * commands, capability bits). Pushed once per session register and replayed
   * on PWA subscribe / hub reconnect. Keyed by `${daemon_id}::${session_id}`.
   */
  agentHandshakes: Record<string, PwaAgentHandshake>;
}

export function eventKey(daemon_id: string, session_id: string): string {
  return `${daemon_id}::${session_id}`;
}

export function initialHubState(): HubState {
  return {
    connected: false, daemons: [], events: {}, pendingPermissions: {},
    pendingQuestions: {},
    completedCounts: {},
    chatMessages: {}, chatErrors: {},
    startSessionErrors: {},
    noMoreHistory: {},
    pendingCommands: {},
    slashInventory: {},
    agentHandshakes: {},
  };
}

// ─── Action union ─────────────────────────────────────────────────────────────

export type HubAction =
  | { type: "frame"; frame: HubToPwa }
  | {
      type: "outbound_chat_send";
      daemon_id: string;
      session_id: string;
      client_message_id: string;
      started_at: number;
    }
  | { type: "outbound_start_session"; daemon_id: string; request_id: string; started_at: number }
  | { type: "outbound_request_history"; daemon_id: string; session_id: string; request_id: string; started_at: number }
  | { type: "outbound_permission_reply"; daemon_id: string; session_id: string; request_id: string; decision: "allow" | "deny"; started_at: number }
  | { type: "outbound_ask_answer"; daemon_id: string; session_id: string; request_id: string; started_at: number }
  | { type: "outbound_kill_session"; daemon_id: string; session_id: string; started_at: number }
  | { type: "command_timeout"; id: string }
  | { type: "command_dismiss"; id: string }
  | { type: "clear_start_session_error"; daemon_id: string };

// ─── Pure reducer ─────────────────────────────────────────────────────────────

export function reducer(state: HubState, action: HubAction): HubState {
  switch (action.type) {
    case "outbound_start_session": {
      const cleaned = dropStalePending(state.pendingCommands, (c) =>
        c.kind === "start_session"
        && c.daemon_id === action.daemon_id
        && c.status !== "pending",
      );
      const cmd: PendingCommand = {
        id: action.request_id,
        kind: "start_session",
        daemon_id: action.daemon_id,
        started_at: action.started_at,
        status: "pending",
      };
      return { ...state, pendingCommands: createPending(cleaned, cmd) };
    }

    case "outbound_chat_send": {
      const cleaned = dropStalePending(state.pendingCommands, (c) =>
        c.kind === "chat_send"
        && c.daemon_id === action.daemon_id
        && c.session_id === action.session_id
        && c.status !== "pending",
      );
      const cmd: PendingCommand = {
        id: action.client_message_id,
        kind: "chat_send",
        daemon_id: action.daemon_id,
        session_id: action.session_id,
        started_at: action.started_at,
        status: "pending",
      };
      return { ...state, pendingCommands: createPending(cleaned, cmd) };
    }

    case "outbound_request_history": {
      const cleaned = dropStalePending(state.pendingCommands, (c) =>
        c.kind === "request_history"
        && c.daemon_id === action.daemon_id
        && c.session_id === action.session_id
        && c.status !== "pending",
      );
      const existing = Object.values(cleaned).find(
        (c) => c.kind === "request_history"
            && c.daemon_id === action.daemon_id
            && c.session_id === action.session_id
            && c.status === "pending",
      );
      if (existing) {
        // A live pending entry already covers this scope.
        // Commit the drop of stale entries if any were removed.
        if (cleaned !== state.pendingCommands) {
          return { ...state, pendingCommands: cleaned };
        }
        return state;
      }
      const cmd: PendingCommand = {
        id: action.request_id,
        kind: "request_history",
        daemon_id: action.daemon_id,
        session_id: action.session_id,
        started_at: action.started_at,
        status: "pending",
      };
      return { ...state, pendingCommands: createPending(cleaned, cmd) };
    }

    case "outbound_permission_reply": {
      const cleaned = dropStalePending(state.pendingCommands, (c) =>
        c.kind === "permission_reply"
        && c.id === action.request_id
        && c.status !== "pending",
      );
      const cmd: PendingCommand = {
        id: action.request_id,
        kind: "permission_reply",
        daemon_id: action.daemon_id,
        session_id: action.session_id,
        started_at: action.started_at,
        status: "pending",
        label: action.decision,
      };
      return { ...state, pendingCommands: createPending(cleaned, cmd) };
    }

    case "outbound_ask_answer": {
      const cleaned = dropStalePending(state.pendingCommands, (c) =>
        c.kind === "ask_answer"
        && c.id === action.request_id
        && c.status !== "pending",
      );
      const cmd: PendingCommand = {
        id: action.request_id,
        kind: "ask_answer",
        daemon_id: action.daemon_id,
        session_id: action.session_id,
        started_at: action.started_at,
        status: "pending",
      };
      return { ...state, pendingCommands: createPending(cleaned, cmd) };
    }

    case "outbound_kill_session": {
      const id = killCommandId(action.daemon_id, action.session_id);
      if (state.pendingCommands[id]) return state;
      const cmd: PendingCommand = {
        id,
        kind: "kill_session",
        daemon_id: action.daemon_id,
        session_id: action.session_id,
        started_at: action.started_at,
        status: "pending",
      };
      return { ...state, pendingCommands: createPending(state.pendingCommands, cmd) };
    }

    case "command_timeout": {
      const next = timeoutPending(state.pendingCommands, action.id);
      if (next === state.pendingCommands) return state;
      return { ...state, pendingCommands: next };
    }

    case "command_dismiss": {
      const next = dismissPending(state.pendingCommands, action.id);
      if (next === state.pendingCommands) return state;
      return { ...state, pendingCommands: next };
    }

    case "clear_start_session_error": {
      if (!state.startSessionErrors[action.daemon_id]) return state;
      const next = { ...state.startSessionErrors };
      delete next[action.daemon_id];
      return { ...state, startSessionErrors: next };
    }

    case "frame": {
      const frame = action.frame;
      const prev = state;
      switch (frame.type) {
        case "snapshot":
          return { ...prev, daemons: frame.daemons };
        case "daemon_online":
          return {
            ...prev,
            daemons: [
              ...prev.daemons.filter((d) => d.daemon_id !== frame.daemon_id),
              { daemon_id: frame.daemon_id, hostname: frame.hostname,
                display_name: frame.display_name,
                online: true, sessions: frame.sessions },
            ],
          };
        case "daemon_offline":
          return {
            ...prev,
            daemons: prev.daemons.map((d) =>
              d.daemon_id === frame.daemon_id ? { ...d, online: false } : d),
          };
        case "daemon_renamed":
          return {
            ...prev,
            daemons: prev.daemons.map((d) =>
              d.daemon_id === frame.daemon_id ? { ...d, display_name: frame.display_name } : d),
          };
        case "session_open": {
          const reqId = frame.request_id;
          const nextPending = reqId ? confirmPending(prev.pendingCommands, reqId) : prev.pendingCommands;
          return {
            ...prev,
            daemons: prev.daemons.map((d) =>
              d.daemon_id === frame.daemon_id
                ? { ...d, sessions: [...d.sessions.filter((s) => s.session_id !== frame.session.session_id), frame.session] }
                : d),
            pendingCommands: nextPending,
          };
        }
        case "session_close":
          return {
            ...prev,
            daemons: prev.daemons.map((d) =>
              d.daemon_id === frame.daemon_id
                ? { ...d, sessions: d.sessions.filter((s) => s.session_id !== frame.session_id) }
                : d),
            pendingCommands: confirmPending(prev.pendingCommands, killCommandId(frame.daemon_id, frame.session_id)),
          };
        case "session_rebound": {
          // CC rotated its conversation (`/clear`, `--resume`, etc.) — the
          // daemon rebound to a new claude_session_id. Drop all timeline
          // state for this session so the UI starts from a clean slate.
          const k = eventKey(frame.daemon_id, frame.session_id);
          const nextEvents = { ...prev.events };       delete nextEvents[k];
          const nextChatMsgs = { ...prev.chatMessages }; delete nextChatMsgs[k];
          const nextChatErrs = { ...prev.chatErrors }; delete nextChatErrs[k];
          const nextNoMore = { ...prev.noMoreHistory }; delete nextNoMore[k];
          const nextCompleted = { ...prev.completedCounts }; delete nextCompleted[k];
          return {
            ...prev,
            events: nextEvents,
            chatMessages: nextChatMsgs,
            chatErrors: nextChatErrs,
            noMoreHistory: nextNoMore,
            completedCounts: nextCompleted,
          };
        }
        case "event": {
          recordRenderSpan("event", frame.trace, {
            daemon_id: frame.daemon_id,
            session_id: frame.session_id,
            jsonl_offset: frame.jsonl_offset,
          });
          const k = eventKey(frame.daemon_id, frame.session_id);
          const existing = prev.events[k] ?? [];
          const trimmed = appendEventToBuffer(existing, frame);
          // Dedup hit — bail unchanged so React skips the rerender.
          if (trimmed === existing) return prev;
          // A new live event invalidates any prior `noMoreHistory[k]=true`
          // verdict, which was set against a snapshot of the JSONL at
          // request_history time. The file has grown since; re-checking
          // earlier offsets is the user's call (Load earlier events
          // button reappears once items.length > 0).
          const nextNoMore = prev.noMoreHistory[k]
            ? (() => { const n = { ...prev.noMoreHistory }; delete n[k]; return n; })()
            : prev.noMoreHistory;
          return {
            ...prev,
            events: { ...prev.events, [k]: trimmed },
            noMoreHistory: nextNoMore,
          };
        }
        case "history_chunk": {
          const k = eventKey(frame.daemon_id, frame.session_id);
          // An empty chunk means the daemon has no more JSONL lines older
          // than `before_offset` — track this so the UI can hide the
          // "Load earlier events" button.
          if (frame.events.length === 0) {
            return {
              ...prev,
              noMoreHistory: { ...prev.noMoreHistory, [k]: true },
              pendingCommands: confirmPending(prev.pendingCommands, frame.request_id),
            };
          }
          const existing = prev.events[k] ?? [];
          const dedupedOffsets = new Set(existing.map((e) => e.jsonl_offset));
          const newFlat: BufferedEvent[] = [];
          for (const h of frame.events) {
            if (dedupedOffsets.has(h.jsonl_offset)) continue;
            h.payload.forEach((event, event_index) => {
              newFlat.push({
                daemon_id: frame.daemon_id,
                session_id: frame.session_id,
                jsonl_offset: h.jsonl_offset,
                event_index,
                // Same source-of-truth as the live path: the adapter
                // attaches AG-UI `timestamp` from the JSONL row. Ts=0
                // is fine; mergeTimeline secondary-sorts by jsonl_offset.
                ts: (event as { timestamp?: number }).timestamp ?? 0,
                event,
              });
            });
          }
          if (newFlat.length === 0) {
            return {
              ...prev,
              pendingCommands: confirmPending(prev.pendingCommands, frame.request_id),
            };
          }
          const merged = [...newFlat, ...existing].sort((a, b) => a.jsonl_offset - b.jsonl_offset);
          const trimmed = merged.length > PER_SESSION_BUFFER
            ? merged.slice(merged.length - PER_SESSION_BUFFER)
            : merged;
          return {
            ...prev,
            events: { ...prev.events, [k]: trimmed },
            pendingCommands: confirmPending(prev.pendingCommands, frame.request_id),
          };
        }
        case "permission_request":
          return {
            ...prev,
            pendingPermissions: { ...prev.pendingPermissions, [frame.request_id]: frame },
          };
        case "permission_resolved": {
          const nextPending = confirmPending(prev.pendingCommands, frame.request_id);
          if (!prev.pendingPermissions[frame.request_id]) {
            // No local pendingPermissions entry (e.g. cross-device), but still
            // clear pendingCommands if it has an entry for this request_id.
            if (nextPending === prev.pendingCommands) return prev;
            return { ...prev, pendingCommands: nextPending };
          }
          const next = { ...prev.pendingPermissions };
          delete next[frame.request_id];
          return { ...prev, pendingPermissions: next, pendingCommands: nextPending };
        }
        case "ask_user_question_request":
          return {
            ...prev,
            pendingQuestions: { ...prev.pendingQuestions, [frame.request_id]: frame },
          };
        case "ask_user_question_resolved": {
          const nextPending = confirmPending(prev.pendingCommands, frame.request_id);
          if (!prev.pendingQuestions[frame.request_id]) {
            if (nextPending === prev.pendingCommands) return prev;
            return { ...prev, pendingCommands: nextPending };
          }
          const next = { ...prev.pendingQuestions };
          delete next[frame.request_id];
          return { ...prev, pendingQuestions: next, pendingCommands: nextPending };
        }
        case "task_completed": {
          const k = eventKey(frame.daemon_id, frame.session_id);
          const prevCount = prev.completedCounts[k] ?? 0;
          return {
            ...prev,
            completedCounts: { ...prev.completedCounts, [k]: prevCount + 1 },
          };
        }
        case "idle": {
          // Informational notification only — actual state is tracked via
          // the session_state frame. Kept for forward-compat with downstream
          // listeners (e.g. push prefs use the daemon's idle frame too).
          return prev;
        }
        case "session_state": {
          const updateSession = (s: typeof prev.daemons[number]["sessions"][number]) =>
            s.session_id === frame.session_id ? { ...s, state: frame.state as SessionState } : s;
          return {
            ...prev,
            daemons: prev.daemons.map((d) =>
              d.daemon_id === frame.daemon_id
                ? { ...d, sessions: d.sessions.map(updateSession) }
                : d),
          };
        }
        case "chat": {
          const k = eventKey(frame.daemon_id, frame.session_id);
          const existing = prev.chatMessages[k] ?? [];
          // Dedup by message_id (echo + broadcast may double-deliver in
          // pathological cases).
          if (existing.some((m) => m.message_id === frame.message_id)) return prev;
          const next = existing.concat([frame]);
          const trimmed = next.length > PER_SESSION_CHAT_BUFFER
            ? next.slice(next.length - PER_SESSION_CHAT_BUFFER)
            : next;
          // Clear any prior chat error on successful broadcast.
          const nextErrors = { ...prev.chatErrors };
          delete nextErrors[k];
          // Confirm pending if client_message_id matches.
          const cmid = frame.client_message_id;
          const nextPending = cmid
            ? confirmPending(prev.pendingCommands, cmid)
            : prev.pendingCommands;
          return {
            ...prev,
            chatMessages: { ...prev.chatMessages, [k]: trimmed },
            chatErrors: nextErrors,
            pendingCommands: nextPending,
          };
        }
        case "chat_error": {
          const k = eventKey(frame.daemon_id, frame.session_id);
          // Fail pending if client_message_id matches.
          const cmid = frame.client_message_id;
          const nextPending = cmid
            ? failPending(prev.pendingCommands, cmid, frame.reason)
            : prev.pendingCommands;
          return {
            ...prev,
            chatErrors: { ...prev.chatErrors, [k]: frame.reason },
            pendingCommands: nextPending,
          };
        }
        case "start_session_rejected": {
          const reqId = frame.request_id ?? null;
          const nextPending = reqId ? failPending(prev.pendingCommands, reqId, frame.message) : prev.pendingCommands;
          return {
            ...prev,
            startSessionErrors: {
              ...prev.startSessionErrors,
              [frame.daemon_id]: frame,
            },
            pendingCommands: nextPending,
          };
        }
        case "slash_inventory": {
          const k = eventKey(frame.daemon_id, frame.session_id);
          return {
            ...prev,
            slashInventory: { ...prev.slashInventory, [k]: frame.entries },
          };
        }
        case "agent_handshake": {
          const k = eventKey(frame.daemon_id, frame.session_id);
          return {
            ...prev,
            agentHandshakes: { ...prev.agentHandshakes, [k]: frame },
            // Mirror available_commands into the legacy slashInventory slice
            // so SlashMenu callers don't have to migrate. Once the legacy
            // `slash_inventory` frame is fully retired, this mirror is the
            // single source of truth.
            slashInventory: { ...prev.slashInventory, [k]: frame.available_commands },
          };
        }
        case "fs_list_result": {
          // Out-of-band: useFsList listens via its own callback registry on
          // the hub hook. The reducer has no state for this frame type, but
          // the case is needed for exhaustiveness over HubToPwa.
          return prev;
        }
      }
      return prev;
    }
  }
}

export interface UseHubResult extends HubState {
  sendPermissionReply: (req: PwaPermissionRequest, decision: "allow" | "deny") => void;
  sendAskAnswer: (req: PwaAskUserQuestionRequest, answers: (string | null)[]) => void;
  requestHistory: (daemon_id: string, session_id: string, before_offset: number, limit: number) => void;
  killSession: (daemon_id: string, session_id: string) => void;
  startSession: (daemon_id: string, cwd: string, name?: string) => void;
  sendChat: (daemon_id: string, session_id: string, content: string, reply_to?: string) => void;
  sendCliCommand: (daemon_id: string, session_id: string, text: string) => void;
  /**
   * Send an `fs_list` request and register `onResult` to be called with the
   * matching `fs_list_result` frame. Returns a disposer that unregisters
   * the callback (call it on unmount / supersession). If the websocket
   * isn't open the request is dropped silently and `onResult` is never
   * invoked — the caller should keep its own timeout.
   */
  sendFsList: (
    daemon_id: string,
    parent: string,
    request_id: string,
    onResult: (frame: PwaFsListResult) => void,
  ) => () => void;
  clearStartSessionError: (daemon_id: string) => void;
  pendingChatSendFor: (daemon_id: string, session_id: string) => PendingCommand | undefined;
  pendingStartSessionFor: (daemon_id: string) => PendingCommand | undefined;
  pendingHistoryFor: (daemon_id: string, session_id: string) => PendingCommand | undefined;
  pendingPermissionReplyFor: (request_id: string) => PendingCommand | undefined;
  pendingKillFor: (daemon_id: string, session_id: string) => PendingCommand | undefined;
  dismissPendingCommand: (id: string) => void;
}

export function useHub(
  hubUrl: string,
  bearer: string | null,
  options?: { onAuthFailure?: () => void },
): UseHubResult {
  const [state, setState] = useState<HubState>(initialHubState);
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);
  const wsRef = useRef<WebSocket | null>(null);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // request_id → callback. fs_list responses are looked up here BEFORE
  // hitting the reducer (the reducer no-ops on fs_list_result).
  const fsListListenersRef = useRef<Map<string, (f: PwaFsListResult) => void>>(new Map());

  const clearTimer = useCallback((id: string) => {
    const handle = timersRef.current.get(id);
    if (handle !== undefined) {
      clearTimeout(handle);
      timersRef.current.delete(id);
    }
  }, []);

  const armTimeout = useCallback((id: string) => {
    clearTimer(id);
    const handle = setTimeout(() => {
      timersRef.current.delete(id);
      setState((prev) => reducer(prev, { type: "command_timeout", id }));
    }, COMMAND_TIMEOUT_MS);
    timersRef.current.set(id, handle);
  }, [clearTimer]);

  // Synchronize timersRef with committed state: clear any timer whose
  // corresponding entry is no longer pending (confirmed, failed, timed_out).
  useEffect(() => {
    for (const id of Array.from(timersRef.current.keys())) {
      const entry = state.pendingCommands[id];
      if (!entry || entry.status !== "pending") {
        clearTimer(id);
      }
    }
  }, [state.pendingCommands]);

  useEffect(() => {
    let stopped = false;
    let backoff = 500;

    const apply = (frame: HubToPwa) => {
      setState((prev) => reducer(prev, { type: "frame", frame }));
    };

    let epoch = 0;          // monotonic within this effect closure.
    let framelessOpens = 0;
    const connect = () => {
      if (stopped) return;
      const myEpoch = ++epoch;
      let receivedAnyFrame = false;
      // Heartbeat state — per connect() closure. See spec
      // docs/superpowers/specs/2026-06-06-ws-heartbeat-design.md.
      // The same setInterval drives both ping send and watchdog check;
      // splitting into two timers would produce false-positive disconnects
      // when the browser tab is backgrounded (setInterval throttles to 1Hz
      // on iOS; ping would slow but a fast watchdog would fire).
      let lastPongAt = Date.now();
      let pingTimer: ReturnType<typeof setInterval> | null = null;
      const stopHeartbeat = () => {
        if (pingTimer !== null) { clearInterval(pingTimer); pingTimer = null; }
      };
      const sep = hubUrl.includes("?") ? "&" : "?";
      const wsUrl = bearer
        ? `${hubUrl}/ws/pwa${sep}bearer=${encodeURIComponent(bearer)}`
        : `${hubUrl}/ws/pwa`;
      const ws = new WebSocket(wsUrl);
      // Take ownership of wsRef. A later connect() (within or across effect
      // closures) may overwrite it; that's fine — we only operate on
      // wsRef when it still equals our `ws`.
      wsRef.current = ws;

      ws.onopen = () => {
        if (stopped) { try { ws.close(); } catch {} return; }
        if (myEpoch !== epoch) { try { ws.close(); } catch {} return; }
        // If a NEWER ws (from a different closure) has already taken over
        // wsRef, this open is for an orphaned ws — close and bail.
        if (wsRef.current !== ws) { try { ws.close(); } catch {} return; }
        backoff = 500;
        setState((s) => ({ ...s, connected: true }));
        const sub: PwaToHub = { type: "subscribe" };
        ws.send(JSON.stringify(sub));
        // Start heartbeat after subscribe.
        lastPongAt = Date.now();
        stopHeartbeat();
        pingTimer = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          if (Date.now() - lastPongAt > 45_000) {
            try { ws.close(); } catch {}
            return;
          }
          ws.send(JSON.stringify({ type: "ping", ts: Date.now() } satisfies PwaToHub));
        }, 25_000);
      };
      ws.onmessage = (ev) => {
        if (wsRef.current !== ws) return;   // stale frame from an orphan ws
        receivedAnyFrame = true;
        framelessOpens = 0;
        try {
          const frame = JSON.parse(ev.data) as HubToPwa;
          // Heartbeat reply — record liveness and don't forward to reducer.
          if (frame.type === "pong") {
            lastPongAt = Date.now();
            return;
          }
          // fs_list_result is delivered out-of-band — useFsList registers
          // its own listener via sendFsList() rather than reducing into
          // hub state. Look up + invoke the listener, then DON'T forward
          // to the reducer (which only no-ops anyway).
          if (frame.type === "fs_list_result") {
            const cb = fsListListenersRef.current.get(frame.request_id);
            if (cb) cb(frame);
            return;
          }
          apply(frame);
        } catch {}
      };
      const reconnect = () => {
        stopHeartbeat();
        // Only clear wsRef if THIS ws is still the active one. A newer ws
        // (from a different effect closure or a later connect within the
        // same closure) may already own wsRef; clobbering it to null here
        // would orphan the live connection and make sendChat / sendCommand
        // silently drop.
        if (wsRef.current === ws) {
          wsRef.current = null;
          setState((s) => ({ ...s, connected: false }));
        }
        if (stopped) return;
        if (myEpoch !== epoch) return;
        // Distinguish "browser is offline" from "hub is unreachable / auth invalid".
        // The auth-failure guard should still fire for the latter (scenario 14:
        // stale bearer → 3 frameless closes → onAuthFailure → SignInScreen),
        // but NOT during a transient offline window where reconnects are
        // expected to recover (scenario 12).
        const browserOnline = typeof navigator === "undefined" || navigator.onLine;
        if (browserOnline && !receivedAnyFrame) {
          framelessOpens += 1;
          if (framelessOpens >= 3) {
            stopped = true;
            options?.onAuthFailure?.();
            return;
          }
        } else if (receivedAnyFrame) {
          framelessOpens = 0;
        }
        const delay = backoff;
        backoff = Math.min(backoff * 2, 10_000);
        setTimeout(connect, delay);
      };
      ws.onclose = reconnect;
      ws.onerror = () => { try { ws.close(); } catch {} };
    };

    connect();
    return () => {
      stopped = true;
      try { wsRef.current?.close(); } catch {}
      for (const h of timersRef.current.values()) clearTimeout(h);
      timersRef.current.clear();
    };
  }, [hubUrl, bearer]);

  const sendPermissionReply = useCallback(
    (req: PwaPermissionRequest, decision: "allow" | "deny") => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const msg: PwaToHub = {
        type: "permission_reply",
        daemon_id: req.daemon_id,
        session_id: req.session_id,
        request_id: req.request_id,
        decision,
      };
      ws.send(JSON.stringify(msg));
      setState((prev) => reducer(prev, {
        type: "outbound_permission_reply",
        daemon_id: req.daemon_id,
        session_id: req.session_id,
        request_id: req.request_id,
        decision,
        started_at: Date.now(),
      }));
      armTimeout(req.request_id);
    },
    [armTimeout],
  );

  const sendAskAnswer = useCallback(
    (req: PwaAskUserQuestionRequest, answers: (string | null)[]) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const msg: PwaToHub = {
        type: "ask_user_question_answer",
        daemon_id: req.daemon_id,
        session_id: req.session_id,
        request_id: req.request_id,
        answers,
      };
      ws.send(JSON.stringify(msg));
      setState((prev) => reducer(prev, {
        type: "outbound_ask_answer",
        daemon_id: req.daemon_id,
        session_id: req.session_id,
        request_id: req.request_id,
        started_at: Date.now(),
      }));
      armTimeout(req.request_id);
    },
    [armTimeout],
  );

  const requestHistory = useCallback(
    (daemon_id: string, session_id: string, before_offset: number, limit: number) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const alreadyPending = Object.values(stateRef.current.pendingCommands).some(
        (c) => c.kind === "request_history"
            && c.daemon_id === daemon_id
            && c.session_id === session_id
            && c.status === "pending",
      );
      if (alreadyPending) return;
      const request_id = `rh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const msg: PwaToHub = {
        type: "request_history",
        daemon_id, session_id, request_id, before_offset, limit,
      };
      ws.send(JSON.stringify(msg));
      setState((prev) => reducer(prev, {
        type: "outbound_request_history",
        daemon_id, session_id, request_id,
        started_at: Date.now(),
      }));
      armTimeout(request_id);
    },
    [armTimeout],
  );

  const killSession = useCallback(
    (daemon_id: string, session_id: string) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const id = killCommandId(daemon_id, session_id);
      if (stateRef.current.pendingCommands[id]) return;
      const msg: PwaToHub = { type: "kill_session", daemon_id, session_id };
      ws.send(JSON.stringify(msg));
      setState((prev) => reducer(prev, {
        type: "outbound_kill_session",
        daemon_id, session_id,
        started_at: Date.now(),
      }));
      armTimeout(id);
    },
    [armTimeout],
  );

  const startSession = useCallback(
    (daemon_id: string, cwd: string, name?: string) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const request_id = `rs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setState((prev) =>
        reducer(
          reducer(prev, { type: "clear_start_session_error", daemon_id }),
          { type: "outbound_start_session", daemon_id, request_id, started_at: Date.now() },
        ),
      );
      const msg: PwaToHub = {
        type: "start_session",
        daemon_id, cwd, request_id,
        ...(name ? { name } : {}),
      };
      ws.send(JSON.stringify(msg));
      armTimeout(request_id);
    },
    [armTimeout],
  );

  const clearStartSessionError = useCallback(
    (daemon_id: string) => {
      setState((prev) => reducer(prev, { type: "clear_start_session_error", daemon_id }));
    },
    [],
  );

  const sendChat = useCallback(
    (daemon_id: string, session_id: string, content: string, reply_to?: string) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const client_message_id = `cm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      // Open the round-trip's PWA root span. startUserSpan ends the span
      // synchronously and returns its trace ctx, which we stamp on the
      // outbound frame so hub continues the trace.
      const { trace: traceCtx } = startUserSpan(
        "sendChat",
        { daemon_id, session_id, message_len: content.length },
        () => undefined,
      );
      const msg: PwaToHub = {
        type: "chat_send",
        daemon_id, session_id, content,
        client_message_id,
        ...(reply_to ? { reply_to } : {}),
        ...(traceCtx ? { trace: traceCtx } : {}),
      };
      ws.send(JSON.stringify(msg));
      setState((prev) =>
        reducer(prev, {
          type: "outbound_chat_send",
          daemon_id, session_id, client_message_id,
          started_at: Date.now(),
        }),
      );
      armTimeout(client_message_id);
    },
    [armTimeout],
  );

  const sendCliCommand = useCallback(
    (daemon_id: string, session_id: string, text: string) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const msg: PwaToHub = {
        type: "cli_command",
        daemon_id, session_id, text,
      };
      ws.send(JSON.stringify(msg));
      // No pending state — there is no ack frame; success surfaces via JSONL.
    },
    [],
  );

  const sendFsList = useCallback(
    (
      daemon_id: string,
      parent: string,
      request_id: string,
      onResult: (frame: PwaFsListResult) => void,
    ): (() => void) => {
      fsListListenersRef.current.set(request_id, onResult);
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        const msg: PwaToHub = { type: "fs_list", daemon_id, path: parent, request_id };
        ws.send(JSON.stringify(msg));
      }
      // The disposer is idempotent — caller can call it on unmount as well
      // as after a result fires (so a late-arriving duplicate is ignored).
      return () => {
        fsListListenersRef.current.delete(request_id);
      };
    },
    [],
  );

  const pendingChatSendFor = useCallback(
    (daemon_id: string, session_id: string): PendingCommand | undefined => {
      return findPending(state.pendingCommands, (cmd) =>
        cmd.kind === "chat_send" &&
        cmd.daemon_id === daemon_id &&
        cmd.session_id === session_id,
      );
    },
    [state.pendingCommands],
  );

  const pendingStartSessionFor = useCallback(
    (daemon_id: string): PendingCommand | undefined => {
      for (const v of Object.values(state.pendingCommands)) {
        if (v.kind === "start_session" && v.daemon_id === daemon_id) return v;
      }
      return undefined;
    },
    [state.pendingCommands],
  );

  const pendingHistoryFor = useCallback(
    (daemon_id: string, session_id: string): PendingCommand | undefined => {
      for (const v of Object.values(state.pendingCommands)) {
        if (v.kind === "request_history" && v.daemon_id === daemon_id && v.session_id === session_id) return v;
      }
      return undefined;
    },
    [state.pendingCommands],
  );

  const pendingPermissionReplyFor = useCallback(
    (request_id: string): PendingCommand | undefined => {
      const cmd = state.pendingCommands[request_id];
      return cmd?.kind === "permission_reply" ? cmd : undefined;
    },
    [state.pendingCommands],
  );

  const pendingKillFor = useCallback(
    (daemon_id: string, session_id: string): PendingCommand | undefined =>
      state.pendingCommands[killCommandId(daemon_id, session_id)],
    [state.pendingCommands],
  );

  const dismissPendingCommand = useCallback(
    (id: string) => {
      clearTimer(id);
      setState((prev) => reducer(prev, { type: "command_dismiss", id }));
    },
    [clearTimer],
  );

  return {
    ...state,
    sendPermissionReply, sendAskAnswer, requestHistory, killSession, startSession, sendChat, sendCliCommand,
    sendFsList,
    clearStartSessionError, pendingChatSendFor, pendingStartSessionFor, pendingHistoryFor,
    pendingPermissionReplyFor, pendingKillFor, dismissPendingCommand,
  };
}
