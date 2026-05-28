import type { DaemonToHub, HubToDaemon } from "@cc-remote/proto";
import type { JWK } from "jose";
import { signDpop } from "./dpop.ts";

export interface HubClientOptions {
  hub_url: string;
  daemon_id: string;
  hello: () => DaemonToHub;
  onFrame: (frame: HubToDaemon) => void;
  /**
   * Optional: invoked after every successful (re)connect, *after* hello has
   * been sent. Returns frames to re-send to the hub — used to replay
   * in-flight requests (ask_user_question_request, permission_request) so a
   * hub restart doesn't strand them.
   */
  onOpen?: () => DaemonToHub[];
  jwt?: string;
  privateJwk?: JWK;
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

  const scheduleReconnect = () => {
    ws = null;
    if (stopped) return;
    const delay = backoff;
    backoff = Math.min(backoff * 2, capMs);
    setTimeout(() => { void connect(); }, delay);
  };

  const connect = async () => {
    if (stopped) return;

    let init: { headers?: Record<string, string> } | undefined;
    if (opts.jwt && opts.privateJwk) {
      try {
        const dpop = await signDpop(opts.privateJwk, "GET", url);
        init = { headers: { authorization: `DPoP ${opts.jwt}`, dpop } };
      } catch (e) {
        process.stderr.write(`hub-client: dpop sign failed: ${(e as Error).message}\n`);
        scheduleReconnect();
        return;
      }
    }

    try {
      // Bun extension: WebSocket constructor accepts { headers } in options.
      ws = init ? new WebSocket(url, init as unknown as string[]) : new WebSocket(url);
    } catch (e) {
      process.stderr.write(`hub-client: WebSocket ctor failed: ${(e as Error).message}\n`);
      scheduleReconnect();
      return;
    }

    ws.addEventListener("open", () => {
      backoff = startMs;
      ws!.send(JSON.stringify(opts.hello()));
      const replays = opts.onOpen ? opts.onOpen() : [];
      for (const f of replays) ws!.send(JSON.stringify(f));
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

    ws.addEventListener("close", scheduleReconnect);
    ws.addEventListener("error", () => { try { ws?.close(); } catch {} });
  };

  void connect();

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
