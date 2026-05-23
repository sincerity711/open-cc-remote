import type { ServerWebSocket } from "bun";
import type { DaemonToHub, PwaToHub } from "@cc-remote/proto";
import type { Db } from "./db.ts";
import { DaemonRegistry, PwaRegistry } from "./connections.ts";
import { Router } from "./router.ts";
import { startLogin, handleCallback, type IasContext } from "./auth/ias.ts";
import type { PushHelper } from "./push.ts";

type WsKind = "daemon" | "pwa";
interface WsData { kind: WsKind; key: string; user?: string; user_id?: string; }

export interface MakeServerOpts {
  db?: Db;
  jwt_secret?: string;
  ias?: IasContext;
  disable_auth?: boolean;
  pwa_url?: string;
  push?: PushHelper;
  offline_push_delay_ms?: number;
}

export function makeServer(opts: MakeServerOpts = {}) {
  const daemonReg = new DaemonRegistry<ServerWebSocket<WsData>>();
  const pwaReg = new PwaRegistry<ServerWebSocket<WsData>>();
  const router = new Router(daemonReg, pwaReg, opts.db, opts.push, {
    offline_push_delay_ms: opts.offline_push_delay_ms,
  });

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

    if (url.pathname === "/push/subscribe" && req.method === "POST") {
      if (!opts.db) return new Response("not configured", { status: 503 });
      const { authenticatePwa } = await import("./auth/pwa-auth.ts");
      const auth = authenticatePwa(opts.db, req);
      if ("error" in auth) return new Response(auth.error, { status: 401 });
      try {
        const body = await req.json() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
        if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
          return new Response("bad request", { status: 400 });
        }
        const { addPushSub } = await import("./repos/push-subs.ts");
        addPushSub(opts.db, auth.device_id, body.endpoint, body.keys.p256dh, body.keys.auth);
        return new Response(null, { status: 204 });
      } catch (e) {
        return new Response((e as Error).message, { status: 400 });
      }
    }

    if (url.pathname === "/push/preferences" && req.method === "GET") {
      if (!opts.db) return new Response("not configured", { status: 503 });
      const { authenticatePwa } = await import("./auth/pwa-auth.ts");
      const auth = authenticatePwa(opts.db, req);
      if ("error" in auth) return new Response(auth.error, { status: 401 });
      const { getPreferences } = await import("./repos/push-subs.ts");
      return Response.json(getPreferences(opts.db, auth.device_id));
    }

    if (url.pathname === "/push/preferences" && req.method === "PUT") {
      if (!opts.db) return new Response("not configured", { status: 503 });
      const { authenticatePwa } = await import("./auth/pwa-auth.ts");
      const auth = authenticatePwa(opts.db, req);
      if ("error" in auth) return new Response(auth.error, { status: 401 });
      try {
        const body = await req.json() as { permission?: boolean };
        const { setPreferences } = await import("./repos/push-subs.ts");
        setPreferences(opts.db, auth.device_id, body);
        return new Response(null, { status: 204 });
      } catch (e) {
        return new Response((e as Error).message, { status: 400 });
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

    if (url.pathname === "/pair/refresh" && req.method === "POST") {
      if (!opts.db || !opts.jwt_secret) return new Response("not configured", { status: 503 });
      const auth = req.headers.get("authorization");
      const dpopHeader = req.headers.get("dpop");
      if (!auth?.startsWith("DPoP ") || !dpopHeader) {
        return new Response("DPoP required", { status: 401 });
      }
      const oldJwt = auth.slice(5);
      let daemon_id: string;
      try {
        const { decodeJwt } = await import("jose");
        const claims = decodeJwt(oldJwt);
        if (!claims.sub) return new Response("JWT missing sub", { status: 401 });
        daemon_id = claims.sub;
        const { verifyDaemonAuth } = await import("./auth/dpop-verify.ts");
        await verifyDaemonAuth(
          opts.db, opts.jwt_secret, daemon_id, oldJwt, dpopHeader, req.url, req.method,
        );
      } catch (e) {
        return new Response((e as Error).message, { status: 401 });
      }
      try {
        const { refreshJwt } = await import("./pair.ts");
        const result = await refreshJwt(opts.db, opts.jwt_secret, daemon_id);
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
    if (url.pathname === "/devices" && req.method === "GET") {
      if (!opts.db) return new Response("not configured", { status: 503 });
      const { authenticatePwa } = await import("./auth/pwa-auth.ts");
      const auth = authenticatePwa(opts.db, req);
      if ("error" in auth) return new Response(auth.error, { status: 401 });
      const { listDevicesByOwner } = await import("./repos/devices.ts");
      return Response.json(listDevicesByOwner(opts.db, auth.owner_sub));
    }

    {
      const m = url.pathname.match(/^\/devices\/([^/]+)$/);
      if (m && (req.method === "PATCH" || req.method === "DELETE")) {
        if (!opts.db) return new Response("not configured", { status: 503 });
        const { authenticatePwa } = await import("./auth/pwa-auth.ts");
        const auth = authenticatePwa(opts.db, req);
        if ("error" in auth) return new Response(auth.error, { status: 401 });
        const device_id = decodeURIComponent(m[1]!);
        if (req.method === "PATCH") {
          try {
            const body = await req.json() as { display_name?: string };
            if (typeof body.display_name !== "string") {
              return new Response("bad request", { status: 400 });
            }
            const { renameDevice } = await import("./repos/devices.ts");
            const ok = renameDevice(opts.db, auth.owner_sub, device_id, body.display_name);
            return new Response(null, { status: ok ? 204 : 404 });
          } catch (e) {
            return new Response((e as Error).message, { status: 400 });
          }
        } else {
          const { revokeDeviceAuthorized } = await import("./repos/devices.ts");
          const { removePushSub } = await import("./repos/push-subs.ts");
          const ok = revokeDeviceAuthorized(opts.db, auth.owner_sub, device_id);
          if (ok) removePushSub(opts.db, device_id);
          return new Response(null, { status: ok ? 204 : 404 });
        }
      }
    }

    if (url.pathname === "/daemons" && req.method === "GET") {
      if (!opts.db) return new Response("not configured", { status: 503 });
      const { authenticatePwa } = await import("./auth/pwa-auth.ts");
      const auth = authenticatePwa(opts.db, req);
      if ("error" in auth) return new Response(auth.error, { status: 401 });
      const { listDaemonsByOwner } = await import("./repos/daemons.ts");
      const list = listDaemonsByOwner(opts.db, auth.owner_sub);
      const connected = router.getConnectedDaemonIds();
      const enriched = list.map((d) => ({ ...d, connected: connected.has(d.daemon_id) }));
      enriched.sort((a, b) => {
        if (a.connected !== b.connected) return a.connected ? -1 : 1;
        return b.paired_at - a.paired_at;
      });
      return Response.json(enriched);
    }

    {
      const m = url.pathname.match(/^\/daemons\/([^/]+)$/);
      if (m && (req.method === "PATCH" || req.method === "DELETE")) {
        if (!opts.db) return new Response("not configured", { status: 503 });
        const { authenticatePwa } = await import("./auth/pwa-auth.ts");
        const auth = authenticatePwa(opts.db, req);
        if ("error" in auth) return new Response(auth.error, { status: 401 });
        const daemon_id = decodeURIComponent(m[1]!);
        if (req.method === "PATCH") {
          try {
            const body = await req.json() as { display_name?: unknown };
            if (typeof body.display_name !== "string") {
              return new Response("bad request", { status: 400 });
            }
            const { renameDaemon } = await import("./repos/daemons.ts");
            const ok = renameDaemon(opts.db, auth.owner_sub, daemon_id, body.display_name);
            return new Response(null, { status: ok ? 204 : 404 });
          } catch (e) {
            return new Response((e as Error).message, { status: 400 });
          }
        } else {
          const { revokeDaemonAuthorized } = await import("./repos/daemons.ts");
          const ok = revokeDaemonAuthorized(opts.db, auth.owner_sub, daemon_id);
          if (ok) router.closeDaemonConnection(daemon_id);
          return new Response(null, { status: ok ? 204 : 404 });
        }
      }
    }

    if (url.pathname === "/ws/pwa") {
      let wsUser: string | undefined;
      let wsUserId: string | undefined;
      if (!opts.disable_auth) {
        if (!opts.db) return new Response("auth not configured", { status: 503 });
        const { authenticatePwa } = await import("./auth/pwa-auth.ts");
        const r = authenticatePwa(opts.db, req);
        if ("error" in r) return new Response(r.error, { status: 401 });
        wsUserId = r.owner_sub;
        // Look up email for `user` field on chat frames; fall back to sub.
        const row = opts.db.prepare("SELECT email FROM users WHERE sub = ?").get(r.owner_sub) as { email: string | null } | undefined;
        wsUser = row?.email ?? r.owner_sub;
      } else {
        wsUser = "anonymous";
        wsUserId = "anonymous";
      }
      const ok = server.upgrade(req, { data: { kind: "pwa", key: "", user: wsUser, user_id: wsUserId } satisfies WsData });
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
        ws.data = { kind: "pwa", key: id, user: ws.data.user, user_id: ws.data.user_id };
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
        if (pf.type === "subscribe") {
          router.onPwaSubscribe((f) => ws.send(JSON.stringify(f)));
        } else if (pf.type === "permission_reply" || pf.type === "request_history" || pf.type === "kill_session" || pf.type === "start_session") {
          router.onPwaCommand(pf);
        } else if (pf.type === "chat_send") {
          router.onPwaChatSend(
            pf,
            { user: ws.data.user ?? "anonymous", user_id: ws.data.user_id ?? "anonymous" },
            (f) => ws.send(JSON.stringify(f)),
          );
        }
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
