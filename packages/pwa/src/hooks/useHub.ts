import { useEffect, useRef, useState, useCallback } from "react";
import type {
  HubToPwa, PwaToHub, DaemonView, EventFrameForPwa, PwaPermissionRequest,
  PwaChatBroadcast, SessionState,
} from "@cc-remote/proto";

const PER_SESSION_BUFFER = 2000;
const PER_SESSION_CHAT_BUFFER = 500;

export interface HubState {
  connected: boolean;
  daemons: DaemonView[];
  events: Record<string, EventFrameForPwa[]>;
  pendingPermissions: Record<string, PwaPermissionRequest>;
  completedCounts: Record<string, number>;
  chatMessages: Record<string, PwaChatBroadcast[]>;
  chatErrors: Record<string, string>;  // keyed by eventKey, value = reason of last error
  /**
   * Per-session flag: daemon has confirmed no more JSONL lines exist older
   * than the oldest known event. Set when a request_history returns 0 events.
   * UI uses this to hide the "Load earlier events" button.
   */
  noMoreHistory: Record<string, true>;
}

export function eventKey(daemon_id: string, session_id: string): string {
  return `${daemon_id}::${session_id}`;
}

export interface UseHubResult extends HubState {
  sendPermissionReply: (req: PwaPermissionRequest, decision: "allow" | "deny") => void;
  requestHistory: (daemon_id: string, session_id: string, before_offset: number, limit: number) => void;
  killSession: (daemon_id: string, session_id: string) => void;
  startSession: (daemon_id: string, cwd: string, name?: string) => void;
  sendChat: (daemon_id: string, session_id: string, content: string, reply_to?: string) => void;
}

export function useHub(
  hubUrl: string,
  bearer: string | null,
  options?: { onAuthFailure?: () => void },
): UseHubResult {
  const [state, setState] = useState<HubState>({
    connected: false, daemons: [], events: {}, pendingPermissions: {},
    completedCounts: {},
    chatMessages: {}, chatErrors: {},
    noMoreHistory: {},
  });
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let stopped = false;
    let backoff = 500;

    const apply = (frame: HubToPwa) => {
      setState((prev) => {
        switch (frame.type) {
          case "snapshot":
            return { ...prev, daemons: frame.daemons };
          case "daemon_online":
            return {
              ...prev,
              daemons: [
                ...prev.daemons.filter((d) => d.daemon_id !== frame.daemon_id),
                { daemon_id: frame.daemon_id, hostname: frame.hostname,
                  online: true, sessions: frame.sessions },
              ],
            };
          case "daemon_offline":
            return {
              ...prev,
              daemons: prev.daemons.map((d) =>
                d.daemon_id === frame.daemon_id ? { ...d, online: false } : d),
            };
          case "session_open":
            return {
              ...prev,
              daemons: prev.daemons.map((d) =>
                d.daemon_id === frame.daemon_id
                  ? { ...d, sessions: [...d.sessions.filter((s) => s.session_id !== frame.session.session_id), frame.session] }
                  : d),
            };
          case "session_close":
            return {
              ...prev,
              daemons: prev.daemons.map((d) =>
                d.daemon_id === frame.daemon_id
                  ? { ...d, sessions: d.sessions.filter((s) => s.session_id !== frame.session_id) }
                  : d),
            };
          case "event": {
            const k = eventKey(frame.daemon_id, frame.session_id);
            const existing = prev.events[k] ?? [];
            const next = existing.concat([frame]);
            const trimmed = next.length > PER_SESSION_BUFFER
              ? next.slice(next.length - PER_SESSION_BUFFER)
              : next;
            return {
              ...prev,
              events: { ...prev.events, [k]: trimmed },
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
              };
            }
            const existing = prev.events[k] ?? [];
            const seen = new Set(existing.map((e) => e.jsonl_offset));
            const incoming: EventFrameForPwa[] = frame.events
              .filter((e) => !seen.has(e.jsonl_offset))
              .map((e) => ({
                type: "event",
                daemon_id: frame.daemon_id,
                session_id: frame.session_id,
                jsonl_offset: e.jsonl_offset,
                ts: 0,
                payload: e.payload,
              }));
            if (incoming.length === 0) return prev;
            const merged = [...incoming, ...existing].sort((a, b) => a.jsonl_offset - b.jsonl_offset);
            const trimmed = merged.length > PER_SESSION_BUFFER
              ? merged.slice(merged.length - PER_SESSION_BUFFER)
              : merged;
            return { ...prev, events: { ...prev.events, [k]: trimmed } };
          }
          case "permission_request":
            return {
              ...prev,
              pendingPermissions: { ...prev.pendingPermissions, [frame.request_id]: frame },
            };
          case "permission_resolved": {
            if (!prev.pendingPermissions[frame.request_id]) return prev;
            const next = { ...prev.pendingPermissions };
            delete next[frame.request_id];
            return { ...prev, pendingPermissions: next };
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
            return {
              ...prev,
              chatMessages: { ...prev.chatMessages, [k]: trimmed },
              chatErrors: nextErrors,
            };
          }
          case "chat_error": {
            const k = eventKey(frame.daemon_id, frame.session_id);
            return {
              ...prev,
              chatErrors: { ...prev.chatErrors, [k]: frame.reason },
            };
          }
        }
        return prev;
      });
    };

    let epoch = 0;          // monotonic within this effect closure.
    let framelessOpens = 0;
    const connect = () => {
      if (stopped) return;
      const myEpoch = ++epoch;
      let receivedAnyFrame = false;
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
      };
      ws.onmessage = (ev) => {
        if (wsRef.current !== ws) return;   // stale frame from an orphan ws
        receivedAnyFrame = true;
        framelessOpens = 0;
        try { apply(JSON.parse(ev.data) as HubToPwa); } catch {}
      };
      const reconnect = () => {
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
        if (!receivedAnyFrame) {
          framelessOpens += 1;
          if (framelessOpens >= 3) {
            stopped = true;
            options?.onAuthFailure?.();
            return;
          }
        } else {
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
    return () => { stopped = true; try { wsRef.current?.close(); } catch {} };
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
      setState((prev) => {
        if (!prev.pendingPermissions[req.request_id]) return prev;
        const next = { ...prev.pendingPermissions };
        delete next[req.request_id];
        return { ...prev, pendingPermissions: next };
      });
    },
    [],
  );

  const requestHistory = useCallback(
    (daemon_id: string, session_id: string, before_offset: number, limit: number) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const msg: PwaToHub = {
        type: "request_history",
        daemon_id, session_id,
        request_id: `rh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        before_offset, limit,
      };
      ws.send(JSON.stringify(msg));
    },
    [],
  );

  const killSession = useCallback(
    (daemon_id: string, session_id: string) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const msg: PwaToHub = {
        type: "kill_session",
        daemon_id, session_id,
      };
      ws.send(JSON.stringify(msg));
    },
    [],
  );

  const startSession = useCallback(
    (daemon_id: string, cwd: string, name?: string) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const msg: PwaToHub = {
        type: "start_session",
        daemon_id, cwd,
        ...(name ? { name } : {}),
      };
      ws.send(JSON.stringify(msg));
    },
    [],
  );

  const sendChat = useCallback(
    (daemon_id: string, session_id: string, content: string, reply_to?: string) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const msg: PwaToHub = {
        type: "chat_send",
        daemon_id, session_id, content,
        ...(reply_to ? { reply_to } : {}),
      };
      ws.send(JSON.stringify(msg));
    },
    [],
  );

  return { ...state, sendPermissionReply, requestHistory, killSession, startSession, sendChat };
}
