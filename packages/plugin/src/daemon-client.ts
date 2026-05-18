import { connect, type Socket } from "node:net";
import { encodeFrame, FrameDecoder } from "@cc-remote/proto";
import type { PluginToDaemon, DaemonToPlugin } from "@cc-remote/proto";

export interface DaemonClient {
  send(frame: PluginToDaemon): Promise<DaemonToPlugin>;
  close(): void;
}

export async function connectDaemon(socketPath: string, timeoutMs = 5000): Promise<DaemonClient> {
  const sock = await new Promise<Socket>((resolve, reject) => {
    const s = connect(socketPath);
    const tid = setTimeout(() => { s.destroy(); reject(new Error("connect timeout")); }, timeoutMs);
    s.once("connect", () => { clearTimeout(tid); resolve(s); });
    s.once("error", (e) => { clearTimeout(tid); reject(e); });
  });

  const decoder = new FrameDecoder();
  const queue: Array<(f: DaemonToPlugin) => void> = [];

  sock.on("data", (chunk: Buffer) => {
    try {
      for (const f of decoder.push(chunk)) {
        const cb = queue.shift();
        if (cb) cb(f as DaemonToPlugin);
      }
    } catch (e) { sock.destroy(e as Error); }
  });

  sock.on("close", () => {
    while (queue.length) queue.shift()!({ type: "ack", ref: "bye" } as DaemonToPlugin);
    // No surprise rejections; treat post-close acks as bye-acks.
  });

  return {
    send(frame: PluginToDaemon) {
      return new Promise<DaemonToPlugin>((resolve) => {
        queue.push(resolve);
        sock.write(encodeFrame(frame));
      });
    },
    close() { try { sock.end(); } catch {} },
  };
}
