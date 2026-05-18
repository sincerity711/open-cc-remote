import { useEffect, useRef, useState } from "react";
import type { HubToPwa, PwaToHub, DaemonView } from "@cc-remote/proto";

export interface HubState {
  connected: boolean;
  daemons: DaemonView[];
}

export function useHub(hubUrl: string, bearer: string | null): HubState {
  const [state, setState] = useState<HubState>({ connected: false, daemons: [] });
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
          case "event":
            return prev; // Plan 3 T6: event display not yet implemented
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

  return state;
}
