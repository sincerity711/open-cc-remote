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
