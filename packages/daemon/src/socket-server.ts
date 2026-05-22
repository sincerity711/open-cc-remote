import { createServer, type Server, type Socket } from "node:net";
import { unlinkSync } from "node:fs";
import { encodeFrame, FrameDecoder } from "@cc-remote/proto";
import type { PluginToDaemon, DaemonToPlugin } from "@cc-remote/proto";

export interface SocketServerOptions {
  path: string;
  onFrame: (frame: PluginToDaemon, client: Socket) => void;
  onClose?: (client: Socket) => void;
}

export interface SocketServerHandle {
  ready: Promise<void>;
  close(): void;
  replyTo(client: Socket, frame: DaemonToPlugin): void;
}

export function startSocketServer(opts: SocketServerOptions): SocketServerHandle {
  try { unlinkSync(opts.path); } catch {}

  const clients = new Set<Socket>();
  const server: Server = createServer((sock) => {
    clients.add(sock);
    const decoder = new FrameDecoder();
    sock.on("data", (chunk: Buffer) => {
      try {
        for (const frame of decoder.push(chunk)) {
          opts.onFrame(frame as PluginToDaemon, sock);
        }
      } catch (e) {
        sock.destroy(e as Error);
      }
    });
    sock.on("close", () => {
      clients.delete(sock);
      opts.onClose?.(sock);
    });
    sock.on("error", () => sock.destroy());
  });

  const ready = new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.path, () => {
      // Tighten permissions: owner-only.
      try {
        const { chmodSync } = require("node:fs");
        chmodSync(opts.path, 0o600);
      } catch {}
      resolve();
    });
  });

  return {
    ready,
    close() {
      // Drop existing clients first — `server.close()` only stops accepting
      // new connections, it does not drop established ones. Without this,
      // a daemon shutdown leaves plugins thinking the socket is alive until
      // their next write fails.
      for (const sock of clients) {
        try { sock.destroy(); } catch {}
      }
      clients.clear();
      server.close();
      try { unlinkSync(opts.path); } catch {}
    },
    replyTo(client: Socket, frame: DaemonToPlugin) {
      client.write(encodeFrame(frame));
    },
  };
}
