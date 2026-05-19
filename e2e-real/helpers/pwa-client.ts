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
  return loc;
}

export async function loginAndConnect(opts: LoginAndConnectOpts): Promise<PwaClient> {
  // 1. /auth/login → 302 → fake-IAS authorize URL
  const r1 = await fetchManual(`${opts.hub_http}/auth/login`);
  if (r1.status !== 302) throw new Error(`/auth/login: expected 302, got ${r1.status} ${await r1.text()}`);
  const authorizeUrl = await followLocation(r1);

  // 2. fake-IAS /authorize → 302 → callback
  // fake-ias serves the issuer at http://fake-ias:7770; the redirect URL contains
  // that hostname. We need to swap to localhost since our test runs on the host.
  // Actually fake-IAS returns Location pointing to HUB_IAS_REDIRECT_URI, which is
  // http://localhost:7745/auth/callback?code=...&state=...
  // But the authorize URL itself lives at the issuer. Reach it via container's
  // mapped port? Compose only exposes hub:7745. So we must hit fake-IAS via the
  // hub container... or expose fake-IAS too.
  //
  // Simpler: the fake-IAS issuer URL the hub publishes is "http://fake-ias:7770",
  // which the host can't resolve. We need to either expose fake-IAS, or hit
  // /authorize via a host-accessible URL.
  //
  // Looking at fake-ias behaviour: /authorize immediately returns a 302 to the
  // redirect_uri with a JWT-encoded "code". The host can't resolve fake-ias.
  // Solution: rewrite the host part of the authorize URL to localhost via
  // a port we expose. We'll add a port mapping for fake-ias if needed.
  //
  // For now: fake-ias redirects URL is "http://fake-ias:7770/authorize?...". We
  // rewrite to use a host-side port (added to compose).
  const rewritten = authorizeUrl.replace(/http:\/\/fake-ias:7770/, "http://localhost:7770");
  const r2 = await fetchManual(rewritten);
  if (r2.status !== 302) throw new Error(`/authorize: expected 302, got ${r2.status} ${await r2.text()}`);
  const callbackUrl = await followLocation(r2);

  // 3. /auth/callback → 302 with Location: <pwa_url>#bearer=<token>
  const r3 = await fetchManual(callbackUrl);
  if (r3.status !== 302) throw new Error(`/auth/callback: expected 302, got ${r3.status} ${await r3.text()}`);
  const finalLoc = await followLocation(r3);
  const m = /[#&]bearer=([^&]+)/.exec(finalLoc);
  if (!m) throw new Error(`callback redirect missing bearer fragment: ${finalLoc}`);
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
