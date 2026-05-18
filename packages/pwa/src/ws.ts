import { useEffect, useRef, useState, useCallback } from "react";
import type { HubToPwa, PwaToHub, DaemonView, EventFrameForPwa, PwaPermissionRequest } from "@cc-remote/proto";

const PER_SESSION_BUFFER = 500;

export interface HubState {
  connected: boolean;
  daemons: DaemonView[];
  events: Record<string, EventFrameForPwa[]>;
  pendingPermissions: Record<string, PwaPermissionRequest>;
}

export function eventKey(daemon_id: string, session_id: string): string {
  return `${daemon_id}::${session_id}`;
}

export interface UseHubResult extends HubState {
  sendPermissionReply: (req: PwaPermissionRequest, decision: "allow" | "deny") => void;
}

export function useHub(hubUrl: string, bearer: string | null): UseHubResult {
  const [state, setState] = useState<HubState>({
    connected: false, daemons: [], events: {}, pendingPermissions: {},
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
          case "history_chunk":
            return prev; // wired in P7-T5
        }
        return prev;
      });
    };

    const connect = () => {
      if (stopped) return;
      const sep = hubUrl.includes("?") ? "&" : "?";
      const wsUrl = bearer
        ? `${hubUrl}/ws/pwa${sep}bearer=${encodeURIComponent(bearer)}`
        : `${hubUrl}/ws/pwa`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        backoff = 500;
        setState((s) => ({ ...s, connected: true }));
        const sub: PwaToHub = { type: "subscribe" };
        ws.send(JSON.stringify(sub));
      };
      ws.onmessage = (ev) => {
        try { apply(JSON.parse(ev.data) as HubToPwa); } catch {}
      };
      const reconnect = () => {
        wsRef.current = null;
        setState((s) => ({ ...s, connected: false }));
        if (stopped) return;
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
      // Optimistically remove from pending — hub will confirm via permission_resolved.
      setState((prev) => {
        if (!prev.pendingPermissions[req.request_id]) return prev;
        const next = { ...prev.pendingPermissions };
        delete next[req.request_id];
        return { ...prev, pendingPermissions: next };
      });
    },
    [],
  );

  return { ...state, sendPermissionReply };
}
