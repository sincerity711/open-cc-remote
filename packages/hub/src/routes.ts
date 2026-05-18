import type { ServerWebSocket } from "bun";
import type { DaemonToHub, PwaToHub } from "@cc-remote/proto";
import type { Db } from "./db.ts";
import { DaemonRegistry, PwaRegistry } from "./connections.ts";
import { Router } from "./router.ts";
import { startLogin, handleCallback, type IasContext } from "./auth/ias.ts";

type WsKind = "daemon" | "pwa";
interface WsData { kind: WsKind; key: string; }

export interface MakeServerOpts {
  db?: Db;
  jwt_secret?: string;
  ias?: IasContext;
  disable_auth?: boolean;
  pwa_url?: string;
}

export function makeServer(opts: MakeServerOpts = {}) {
  const daemonReg = new DaemonRegistry<ServerWebSocket<WsData>>();
  const pwaReg = new PwaRegistry<ServerWebSocket<WsData>>();
  const router = new Router(daemonReg, pwaReg);

  const fetch = async (req: Request, server: ReturnType<typeof Bun.serve>) => {
    const url = new URL(req.url);

    if (url.pathname === "/healthz") return new Response("ok");

    if (url.pathname === "/auth/login") {
      if (!opts.ias) return new Response("IAS not configured", { status: 503 });
      const { url: dest } = startLogin(opts.ias);
      return Response.redirect(dest, 302);
    }

    if (url.pathname === "/auth/callback") {
      if (!opts.ias) return new Response("IAS not configured", { status: 503 });
      if (!opts.db) return new Response("db not configured", { status: 503 });
      try {
        const result = await handleCallback(
          opts.ias, opts.db, url.searchParams, req.headers.get("user-agent"),
        );
        const cookie = `cc_session=${result.bearer}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 24 * 3600}`;
        const redirectTo = `${opts.pwa_url ?? "/"}#bearer=${encodeURIComponent(result.bearer)}`;
        return new Response(null, {
          status: 302,
          headers: { Location: redirectTo, "Set-Cookie": cookie },
        });
      } catch (e) {
        return new Response((e as Error).message, { status: 401 });
      }
    }

    if (url.pathname === "/pair" && req.method === "POST") {
      if (!opts.db || !opts.jwt_secret) return new Response("not configured", { status: 503 });
      try {
        const body = await req.json();
        const { handlePair } = await import("./pair.ts");
        const result = await handlePair(opts.db, opts.jwt_secret, body);
        return Response.json(result);
      } catch (e) {
        return new Response((e as Error).message, { status: 400 });
      }
    }

    if (url.pathname === "/ws/daemon") {
      const id = url.searchParams.get("daemon_id");
      if (!id) return new Response("daemon_id required", { status: 400 });

      if (!opts.disable_auth) {
        if (!opts.db || !opts.jwt_secret) return new Response("auth not configured", { status: 503 });
        const auth = req.headers.get("authorization");
        const dpopHeader = req.headers.get("dpop");
        if (!auth?.startsWith("DPoP ") || !dpopHeader) {
          return new Response("DPoP required", { status: 401 });
        }
        try {
          const { verifyDaemonAuth } = await import("./auth/dpop-verify.ts");
          await verifyDaemonAuth(
            opts.db, opts.jwt_secret, id, auth.slice(5), dpopHeader, req.url, req.method,
          );
        } catch (e) {
          return new Response((e as Error).message, { status: 401 });
        }
      }

      const ok = server.upgrade(req, { data: { kind: "daemon", key: id } satisfies WsData });
      return ok ? undefined : new Response("upgrade failed", { status: 500 });
    }
    if (url.pathname === "/ws/pwa") {
      if (!opts.disable_auth) {
        if (!opts.db) return new Response("auth not configured", { status: 503 });
        const { authenticatePwa } = await import("./auth/pwa-auth.ts");
        const r = authenticatePwa(opts.db, req);
        if ("error" in r) return new Response(r.error, { status: 401 });
      }
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

// Legacy export kept for the routes.test.ts unit test that pre-dates makeServer.
export async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/healthz" && req.method === "GET") return new Response("ok");
  return new Response("not found", { status: 404 });
}
