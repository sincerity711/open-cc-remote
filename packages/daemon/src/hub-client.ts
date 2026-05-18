import type { DaemonToHub, HubToDaemon } from "@cc-remote/proto";

export interface HubClientOptions {
  hub_url: string;
  daemon_id: string;
  hello: () => DaemonToHub;
  onFrame: (frame: HubToDaemon) => void;
  backoffStartMs?: number;
  backoffCapMs?: number;
}

export interface HubClientHandle {
  send(frame: DaemonToHub): boolean;
  close(): void;
  isConnected(): boolean;
}

export function startHubClient(opts: HubClientOptions): HubClientHandle {
  const startMs = opts.backoffStartMs ?? 1000;
  const capMs = opts.backoffCapMs ?? 30_000;
  let backoff = startMs;
  let stopped = false;
  let ws: WebSocket | null = null;
  let pending: DaemonToHub[] = [];

  const url = `${opts.hub_url.replace(/\/$/, "")}/ws/daemon?daemon_id=${encodeURIComponent(opts.daemon_id)}`;

  const connect = () => {
    if (stopped) return;
    ws = new WebSocket(url);

    ws.addEventListener("open", () => {
      backoff = startMs;
      ws!.send(JSON.stringify(opts.hello()));
      while (pending.length > 0) {
        const f = pending.shift()!;
        ws!.send(JSON.stringify(f));
      }
    });

    ws.addEventListener("message", (ev) => {
      try {
        const data = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
        opts.onFrame(JSON.parse(data) as HubToDaemon);
      } catch {}
    });

    const reconnect = () => {
      ws = null;
      if (stopped) return;
      const delay = backoff;
      backoff = Math.min(backoff * 2, capMs);
      setTimeout(connect, delay);
    };
    ws.addEventListener("close", reconnect);
    ws.addEventListener("error", () => { try { ws?.close(); } catch {} });
  };

  connect();

  return {
    send(frame) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(frame));
        return true;
      }
      pending.push(frame);
      return false;
    },
    close() {
      stopped = true;
      try { ws?.close(); } catch {}
    },
    isConnected() {
      return !!ws && ws.readyState === WebSocket.OPEN;
    },
  };
}
