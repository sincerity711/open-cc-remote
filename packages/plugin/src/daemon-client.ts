import { connect, type Socket } from "node:net";
import { encodeFrame, FrameDecoder } from "@cc-remote/proto";
import type { PluginToDaemon, DaemonToPlugin } from "@cc-remote/proto";

export interface DaemonClient {
  send(frame: PluginToDaemon): Promise<DaemonToPlugin>;
  sendOneWay(frame: PluginToDaemon): void;
  onFrame(handler: (f: DaemonToPlugin) => void): void;
  close(): void;
}

export interface ConnectDaemonOptions {
  timeoutMs?: number;
  onClose?: () => void;
}

export async function connectDaemon(socketPath: string, timeoutMsOrOpts: number | ConnectDaemonOptions = 5000): Promise<DaemonClient> {
  const opts: ConnectDaemonOptions = typeof timeoutMsOrOpts === "number"
    ? { timeoutMs: timeoutMsOrOpts }
    : timeoutMsOrOpts;
  const timeoutMs = opts.timeoutMs ?? 5000;

  const sock = await new Promise<Socket>((resolve, reject) => {
    const s = connect(socketPath);
    const tid = setTimeout(() => { s.destroy(); reject(new Error("connect timeout")); }, timeoutMs);
    s.once("connect", () => { clearTimeout(tid); resolve(s); });
    s.once("error", (e) => { clearTimeout(tid); reject(e); });
  });

  const decoder = new FrameDecoder();
  const queue: Array<(f: DaemonToPlugin) => void> = [];
  let frameHandler: ((f: DaemonToPlugin) => void) | null = null;

  sock.on("data", (chunk: Buffer) => {
    try {
      for (const f of decoder.push(chunk)) {
        const cb = queue.shift();
        if (cb) cb(f as DaemonToPlugin);
        else if (frameHandler) frameHandler(f as DaemonToPlugin);
      }
    } catch (e) { sock.destroy(e as Error); }
  });

  sock.on("close", () => {
    while (queue.length) queue.shift()!({ type: "ack", ref: "bye" } as DaemonToPlugin);
    opts.onClose?.();
  });

  return {
    send(frame) {
      return new Promise<DaemonToPlugin>((resolve) => {
        queue.push(resolve);
        sock.write(encodeFrame(frame));
      });
    },
    sendOneWay(frame) { sock.write(encodeFrame(frame)); },
    onFrame(handler) { frameHandler = handler; },
    close() { try { sock.end(); } catch {} },
  };
}

// ─── Reconnecting wrapper ────────────────────────────────────────────────

export interface ReconnectingDaemonOptions {
  /** Initial timeout for the very first connect attempt. */
  initialTimeoutMs?: number;
  /** First retry delay; doubled each failure up to `backoffCapMs`. */
  backoffStartMs?: number;
  backoffCapMs?: number;
  /** Called every time a fresh connection is established AFTER the first one. */
  onReconnected?: () => void;
  /** Optional: visibility hooks. */
  onDisconnected?: () => void;
  onReconnecting?: (attempt: number, delayMs: number) => void;
  /** Frames pushed by the daemon (ack-less) — chat_in, permission_reply,
   * daemon_going_down. Same shape as `DaemonClient.onFrame`. */
  onFrame?: (f: DaemonToPlugin) => void;
}

/**
 * Same `DaemonClient` surface as `connectDaemon`, but the underlying socket
 * auto-reconnects with exponential backoff on close. The first connect must
 * succeed (otherwise we throw — Claude has nothing to talk to). After that,
 * a daemon restart drops us into reconnect mode silently and `onReconnected`
 * fires once we're back up so the caller can re-send `register`.
 *
 * `send()` and `sendOneWay()` while disconnected are dropped (no buffering).
 * `send()` resolves with a synthetic `ack` so callers don't hang. The model
 * is: chat / permission frames are non-critical and Claude will retry; the
 * one frame that matters — `register` — is re-sent by the caller via
 * `onReconnected`.
 */
export async function connectDaemonReconnecting(
  socketPath: string,
  opts: ReconnectingDaemonOptions = {},
): Promise<DaemonClient> {
  const startMs = opts.backoffStartMs ?? 1000;
  const capMs = opts.backoffCapMs ?? 30_000;
  let backoff = startMs;
  let attempt = 0;

  let sock: Socket | null = null;
  let decoder = new FrameDecoder();
  let queue: Array<(f: DaemonToPlugin) => void> = [];
  let frameHandler: ((f: DaemonToPlugin) => void) | null = opts.onFrame ?? null;
  let userClosed = false;

  const wireSocket = (s: Socket, isFirst: boolean) => {
    sock = s;
    decoder = new FrameDecoder();
    queue = [];
    s.on("data", (chunk: Buffer) => {
      try {
        for (const f of decoder.push(chunk)) {
          const cb = queue.shift();
          if (cb) cb(f as DaemonToPlugin);
          else if (frameHandler) frameHandler(f as DaemonToPlugin);
        }
      } catch (e) { s.destroy(e as Error); }
    });
    s.on("close", () => {
      sock = null;
      // Resolve any pending sends so the caller doesn't hang.
      while (queue.length) queue.shift()!({ type: "ack", ref: "bye" } as DaemonToPlugin);
      if (userClosed) return;
      opts.onDisconnected?.();
      scheduleReconnect();
    });
    s.on("error", () => {});
    if (!isFirst) {
      backoff = startMs;
      attempt = 0;
      opts.onReconnected?.();
    }
  };

  const tryConnect = (timeoutMs: number): Promise<Socket> => {
    return new Promise((resolve, reject) => {
      const s = connect(socketPath);
      let settled = false;
      const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
      const tid = setTimeout(() => settle(() => { s.destroy(); reject(new Error("connect timeout")); }), timeoutMs);
      s.once("connect", () => settle(() => { clearTimeout(tid); resolve(s); }));
      // Persistent error listener: even after we settle the promise the
      // socket may emit further errors (e.g. immediately followed by close
      // when destroyed). Without a listener, Node treats it as uncaught.
      s.on("error", (e) => settle(() => { clearTimeout(tid); reject(e); }));
    });
  };

  const scheduleReconnect = () => {
    if (userClosed) return;
    attempt += 1;
    const delay = backoff;
    backoff = Math.min(backoff * 2, capMs);
    opts.onReconnecting?.(attempt, delay);
    const t = setTimeout(() => {
      if (userClosed) return;
      tryConnect(Math.min(delay, 5000))
        .then((s) => wireSocket(s, /* isFirst= */ false))
        .catch(() => scheduleReconnect());
    }, delay);
    // Don't keep the event loop alive solely for the reconnect timer.
    (t as { unref?: () => void }).unref?.();
  };

  // First connect — must succeed.
  const firstTimeout = opts.initialTimeoutMs ?? 5000;
  const first = await tryConnect(firstTimeout);
  wireSocket(first, /* isFirst= */ true);

  return {
    send(frame) {
      return new Promise<DaemonToPlugin>((resolve) => {
        if (!sock) {
          // Disconnected: synthesize an ack so the caller doesn't hang. Real
          // delivery is impossible until reconnect; for non-critical frames
          // (chat_out, permission_request) Claude will reissue on next call.
          resolve({ type: "ack", ref: frame.type === "register" ? "register" : frame.type === "bye" ? "bye" : "chat_out" } as DaemonToPlugin);
          return;
        }
        queue.push(resolve);
        sock.write(encodeFrame(frame));
      });
    },
    sendOneWay(frame) {
      if (!sock) return;
      sock.write(encodeFrame(frame));
    },
    onFrame(handler) { frameHandler = handler; },
    close() {
      userClosed = true;
      try { sock?.end(); } catch {}
    },
  };
}
