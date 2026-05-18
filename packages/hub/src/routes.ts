import type { ServerWebSocket } from "bun";
import type { DaemonToHub, PwaToHub } from "@cc-remote/proto";
import { DaemonRegistry, PwaRegistry } from "./connections.ts";
import { Router } from "./router.ts";

type WsKind = "daemon" | "pwa";
interface WsData { kind: WsKind; key: string; }

export function makeServer() {
  const daemonReg = new DaemonRegistry<ServerWebSocket<WsData>>();
  const pwaReg = new PwaRegistry<ServerWebSocket<WsData>>();
  const router = new Router(daemonReg, pwaReg);

  const fetch = (req: Request, server: ReturnType<typeof Bun.serve>) => {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return new Response("ok");
    if (url.pathname === "/ws/daemon") {
      const id = url.searchParams.get("daemon_id");
      if (!id) return new Response("daemon_id required", { status: 400 });
      const ok = server.upgrade(req, { data: { kind: "daemon", key: id } satisfies WsData });
      return ok ? undefined : new Response("upgrade failed", { status: 500 });
    }
    if (url.pathname === "/ws/pwa") {
      const ok = server.upgrade(req, { data: { kind: "pwa", key: "" } satisfies WsData });
      return ok ? undefined : new Response("upgrade failed", { status: 500 });
    }
    return new Response("not found", { status: 404 });
  };

  const websocket = {
    open(ws: ServerWebSocket<WsData>) {
      if (ws.data.kind === "daemon") {
        daemonReg.add(ws.data.key, ws, (f) => ws.send(JSON.stringify(f)),
          () => ws.close(1000, "replaced"));
      } else {
        const id = pwaReg.add(ws, (f) => ws.send(JSON.stringify(f)));
        ws.data = { kind: "pwa", key: id };
      }
    },
    message(ws: ServerWebSocket<WsData>, msg: string | Buffer) {
      const text = typeof msg === "string" ? msg : msg.toString("utf8");
      let frame: unknown;
      try { frame = JSON.parse(text); } catch { ws.close(1003, "bad json"); return; }
      if (ws.data.kind === "daemon") {
        router.onDaemonFrame(ws.data.key, frame as DaemonToHub);
      } else {
        const pf = frame as PwaToHub;
        if (pf.type === "subscribe") router.onPwaSubscribe((f) => ws.send(JSON.stringify(f)));
      }
    },
    close(ws: ServerWebSocket<WsData>) {
      if (ws.data.kind === "daemon") {
        daemonReg.remove(ws.data.key);
        router.onDaemonDisconnect(ws.data.key);
      } else {
        pwaReg.remove(ws.data.key);
      }
    },
  };

  return { fetch, websocket };
}

// Legacy export kept for Task 3 unit test stability.
export async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/healthz" && req.method === "GET") return new Response("ok");
  return new Response("not found", { status: 404 });
}
