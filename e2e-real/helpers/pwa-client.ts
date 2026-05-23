// Scripted PWA-equivalent client for the e2e-real test suite.
//
// Drives the IAS login chain with manually-followed redirects, opens a
// WebSocket to /ws/pwa, and provides waitFor/approve/deny helpers.

import type { HubToPwa, PwaToHub, PwaPermissionRequest } from "@cc-remote/proto";

export interface LoginAndConnectOpts {
  hub_http: string;     // e.g. http://localhost:7745
  hub_ws: string;       // e.g. ws://localhost:7745
}

export interface PwaClient {
  bearer: string;
  ws: WebSocket;
  inbox: HubToPwa[];
  send(frame: PwaToHub): void;
  /** Predicate may return: a frame `T` (returned), `true` (returns the matched
   * frame as `T`), or any falsy value to keep waiting. */
  waitFor<T extends HubToPwa>(
    predicate: (f: HubToPwa) => T | boolean | undefined | null,
    timeoutMs?: number,
    label?: string,
  ): Promise<T>;
  approve(req: PwaPermissionRequest): void;
  deny(req: PwaPermissionRequest): void;
  close(): void;
}

async function fetchManual(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, redirect: "manual" });
}

async function followLocation(res: Response): Promise<string> {
  const loc = res.headers.get("location");
  if (!loc) throw new Error(`expected redirect, got ${res.status} no Location`);
  // Resolve relative redirects (oidc-provider returns relative paths like
  // /interaction/<uid>) against the request URL.
  return new URL(loc, res.url).toString();
}

/**
 * Follow redirects until we land on a non-redirect response, with hub/IAS
 * hostname rewriting (fake-ias → localhost). Stops at /auth/callback's final
 * fragment redirect (which carries the bearer in the URL hash, not a route to
 * follow). Caps at MAX_HOPS so a misconfiguration can't loop forever.
 */
const MAX_HOPS = 10;

function rewriteHost(url: string): string {
  return url.replace(/http:\/\/fake-ias:7770/g, "http://localhost:7770");
}

async function followChain(initialUrl: string, hubHttp: string): Promise<{ finalUrl: string; finalRes: Response }> {
  let url = rewriteHost(initialUrl);
  let res: Response | null = null;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    res = await fetchManual(url);
    if (res.status !== 302 && res.status !== 303) {
      return { finalUrl: url, finalRes: res };
    }
    const loc = res.headers.get("location");
    if (!loc) throw new Error(`hop ${hop}: ${res.status} but no Location header`);
    const next = rewriteHost(new URL(loc, url).toString());
    // /auth/callback#bearer=… — the bearer is the fragment of the redirect's
    // *target* URL. Once we see it we're done; the next "hop" would just be
    // the PWA SPA loading. Match by hub origin + "#bearer=".
    if (next.startsWith(hubHttp) === false && next.includes("#bearer=")) {
      return { finalUrl: next, finalRes: res };
    }
    if (next.includes("#bearer=")) {
      return { finalUrl: next, finalRes: res };
    }
    url = next;
  }
  throw new Error(`auth chain exceeded ${MAX_HOPS} hops; last url=${url}`);
}

export async function loginAndConnect(opts: LoginAndConnectOpts): Promise<PwaClient> {
  // Follow the full auth chain: /auth/login → fake-ias /authorize →
  // [/interaction/{uid} → /authorize/{uid} (oidc-provider consent hops)] →
  // /auth/callback → SPA URL with #bearer=<token>.
  const { finalUrl } = await followChain(`${opts.hub_http}/auth/login`, opts.hub_http);
  const m = /[#&]bearer=([^&]+)/.exec(finalUrl);
  if (!m) throw new Error(`auth chain ended without bearer fragment: ${finalUrl}`);
  const bearer = decodeURIComponent(m[1]!);

  // 4. Open WSS /ws/pwa?bearer=...
  const ws = new WebSocket(`${opts.hub_ws}/ws/pwa?bearer=${encodeURIComponent(bearer)}`);
  await new Promise<void>((resolve, reject) => {
    const to = setTimeout(() => reject(new Error("ws open timeout")), 10_000);
    ws.addEventListener("open", () => { clearTimeout(to); resolve(); }, { once: true });
    ws.addEventListener("error", (e) => { clearTimeout(to); reject(new Error(`ws error: ${(e as ErrorEvent).message ?? "unknown"}`)); }, { once: true });
  });

  const inbox: HubToPwa[] = [];
  const listeners = new Set<(f: HubToPwa) => void>();
  ws.addEventListener("message", (ev: MessageEvent) => {
    const text = typeof ev.data === "string" ? ev.data : (ev.data as Buffer).toString("utf8");
    let frame: HubToPwa;
    try { frame = JSON.parse(text) as HubToPwa; } catch { return; }
    inbox.push(frame);
    for (const l of listeners) l(frame);
  });

  const send = (frame: PwaToHub) => {
    ws.send(JSON.stringify(frame));
  };

  // Subscribe to live frames + snapshot.
  send({ type: "subscribe" });

  const client: PwaClient = {
    bearer,
    ws,
    inbox,
    send,
    waitFor<T extends HubToPwa>(
      predicate: (f: HubToPwa) => T | boolean | undefined | null,
      timeoutMs = 10_000,
      label = "frame",
    ): Promise<T> {
      // Check existing inbox first.
      for (const f of inbox) {
        const r = predicate(f);
        if (r) return Promise.resolve((r === true ? f : r) as T);
      }
      return new Promise<T>((resolve, reject) => {
        const recentTypes: string[] = [];
        const onFrame = (f: HubToPwa) => {
          recentTypes.push(f.type);
          if (recentTypes.length > 20) recentTypes.shift();
          const r = predicate(f);
          if (r) {
            cleanup();
            resolve((r === true ? f : r) as T);
          }
        };
        const to = setTimeout(() => {
          cleanup();
          reject(new Error(
            `pwa.waitFor("${label}") timed out after ${timeoutMs}ms\n` +
            `  recent frame types: ${recentTypes.join(", ")}`,
          ));
        }, timeoutMs);
        const cleanup = () => {
          clearTimeout(to);
          listeners.delete(onFrame);
        };
        listeners.add(onFrame);
      });
    },
    approve(req: PwaPermissionRequest) {
      send({
        type: "permission_reply",
        daemon_id: req.daemon_id,
        session_id: req.session_id,
        request_id: req.request_id,
        decision: "allow",
      });
    },
    deny(req: PwaPermissionRequest) {
      send({
        type: "permission_reply",
        daemon_id: req.daemon_id,
        session_id: req.session_id,
        request_id: req.request_id,
        decision: "deny",
      });
    },
    close() {
      try { ws.close(); } catch { /* ignore */ }
    },
  };

  return client;
}
