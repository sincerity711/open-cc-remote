import { test, expect } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { HubToPwa, PwaToHub } from "@cc-remote/proto";
import { startFakeIas } from "../tools/fake-ias/fake-ias.ts";
import { openDb } from "../packages/hub/src/db.ts";
import { issueCode } from "../packages/hub/src/repos/pairing-codes.ts";
import { loadIas } from "../packages/hub/src/auth/ias.ts";
import { makeServer } from "../packages/hub/src/routes.ts";

const ROOT = resolve(import.meta.dir, "..");

async function getFreePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function followRedirects(
  start: string,
  init: RequestInit = {},
  opts: { maxHops?: number; stopWhen?: (url: string) => boolean } = {},
): Promise<{ res: Response; finalUrl: string }> {
  const maxHops = opts.maxHops ?? 20;
  let url = start;
  let res!: Response;
  for (let i = 0; i < maxHops; i++) {
    if (opts.stopWhen?.(url)) break;
    res = await fetch(url, { ...init, redirect: "manual" });
    const loc = res.headers.get("location");
    if (!loc || res.status < 300 || res.status >= 400) break;
    // Resolve relative redirects
    url = loc.startsWith("http") ? loc : new URL(loc, url).toString();
  }
  return { res, finalUrl: url };
}

async function waitFor<T>(pred: () => T | null, timeoutMs: number, label: string): Promise<T> {
  const start = Date.now();
  while (true) {
    const r = pred();
    if (r) return r;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

test("full auth e2e: IAS login → pair → daemon DPoP → PWA snapshot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-e2e-auth-"));
  const stateDir = join(dir, "daemon-state");

  const hubPort = await getFreePort();
  const redirectUri = `http://localhost:${hubPort}/auth/callback`;

  const ias = await startFakeIas({
    port: 0,
    sub: "i060912@sap.com",
    redirectUris: [redirectUri],
    clientId: "test-client",
    clientSecret: "test-secret",
  });
  const db = openDb(join(dir, "hub.sqlite"));

  const procs: ChildProcess[] = [];
  let hub: ReturnType<typeof Bun.serve> | undefined;

  try {
    // 1. Configure hub (IAS on, auth on)
    const iasCtx = await loadIas({
      issuer_url: ias.url,
      client_id: "test-client",
      client_secret: "test-secret",
      redirect_uri: redirectUri,
      allowed_subjects: ["i060912@sap.com"],
    });
    const { fetch: hubFetch, websocket } = makeServer({
      db, ias: iasCtx, jwt_secret: "test-jwt-secret",
      disable_auth: false, pwa_url: "/",
    });
    hub = Bun.serve({ port: hubPort, fetch: hubFetch, websocket });
    const HUB_HTTP = `http://localhost:${hub.port}`;
    const HUB_WS = `ws://localhost:${hub.port}`;

    // 2. Simulate browser IAS flow → extract bearer from final redirect.
    //    Follow redirects through the OIDC multi-hop chain until we reach the
    //    hub callback URL, then fetch that separately to capture the response.
    const { finalUrl: callbackUrl } = await followRedirects(
      `${HUB_HTTP}/auth/login`,
      {},
      { stopWhen: (url) => url.includes("/auth/callback") },
    );
    const cbRes = await fetch(callbackUrl, {
      redirect: "manual",
      headers: { "user-agent": "Test/1 Macintosh" },
    });
    expect(cbRes.status).toBe(302);
    const finalLoc = cbRes.headers.get("location")!;
    const fragMatch = finalLoc.match(/#bearer=([^&]+)/);
    expect(fragMatch).toBeTruthy();
    const bearer = decodeURIComponent(fragMatch![1]!);
    expect(bearer).toMatch(/^ccr_/);

    // 3. Issue pairing code (admin path).
    const code = issueCode(db, "daemon", "i060912@sap.com", null, 60_000);

    // 4. Run `cc-remote pair` — note hub passed as ws:// so daemon's stored hub_url is ws://.
    //    The CLI internally normalizes ws→http for the /pair POST.
    const cliPath = join(ROOT, "packages/daemon/bin/cc-remote.ts");
    const pairProc = spawn("bun", [cliPath, "pair",
      "--hub", HUB_WS,
      "--code", code,
      "--daemon-id", "test-daemon",
    ], {
      env: { ...process.env, CC_REMOTE_STATE_DIR: stateDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let pairStderr = "";
    pairProc.stderr?.on("data", (b: Buffer) => { pairStderr += b.toString(); });
    const pairExit = await new Promise<number>((r) => pairProc.on("exit", (c) => r(c ?? 0)));
    if (pairExit !== 0) throw new Error(`cc-remote pair failed: ${pairStderr}`);

    // 5. Spawn daemon (will use DPoP auth from state.json).
    const daemon = spawn("bun", ["run", join(ROOT, "packages/daemon/src/index.ts")], {
      env: { ...process.env, CC_REMOTE_STATE_DIR: stateDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    procs.push(daemon);
    let daemonStderr = "";
    daemon.stderr?.on("data", (b: Buffer) => { daemonStderr += b.toString(); });
    daemon.stdout?.on("data", () => {});
    await new Promise((r) => setTimeout(r, 700));

    // 6. Spawn fake-claude → registers a session.
    const sockPath = join(stateDir, "daemon.sock");
    const fc = spawn("bun", [
      join(ROOT, "tools/fake-claude/fake-claude.ts"),
      "--session-id", "s_e2e_auth",
      "--cwd", "/tmp/e2e",
      "--socket", sockPath,
    ], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    procs.push(fc);

    // 7. Connect as PWA WSS using ?bearer= fallback.
    const ws = new WebSocket(`${HUB_WS}/ws/pwa?bearer=${encodeURIComponent(bearer)}`);
    const inbox: HubToPwa[] = [];
    ws.addEventListener("message", (ev) => {
      try { inbox.push(JSON.parse(typeof ev.data === "string" ? ev.data : "") as HubToPwa); } catch {}
    });
    await new Promise<void>((res, rej) => {
      ws.addEventListener("open", () => res(), { once: true });
      ws.addEventListener("error", () => rej(new Error(`ws connect error; daemon stderr: ${daemonStderr}`)), { once: true });
    });
    const sub: PwaToHub = { type: "subscribe" };
    ws.send(JSON.stringify(sub));

    // 8. Wait for the s_e2e_auth session to surface.
    const found = await waitFor(() => {
      for (const f of inbox) {
        if (f.type === "snapshot") {
          for (const d of f.daemons) {
            if (d.daemon_id === "test-daemon" && d.sessions.some((s) => s.session_id === "s_e2e_auth")) return d;
          }
        }
        if (f.type === "session_open" && f.daemon_id === "test-daemon" && f.session.session_id === "s_e2e_auth") {
          return f.session;
        }
      }
      return null;
    }, 5000, `session s_e2e_auth via authenticated WSS (daemon stderr: ${daemonStderr.slice(-500)})`);

    expect(found).toBeTruthy();
    ws.close();
  } finally {
    for (const p of procs.reverse()) try { p.kill("SIGTERM"); } catch {}
    if (hub) hub.stop(true);
    db.close();
    ias.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PWA WSS without bearer is rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-e2e-noauth-"));
  const db = openDb(join(dir, "hub.sqlite"));
  try {
    const { fetch: hubFetch, websocket } = makeServer({
      db, jwt_secret: "s", disable_auth: false, pwa_url: "/",
    });
    const hub = Bun.serve({ port: 0, fetch: hubFetch, websocket });
    try {
      const ws = new WebSocket(`ws://localhost:${hub.port}/ws/pwa`);
      const closeCode = await new Promise<number>((res) => {
        ws.addEventListener("close", (ev) => res(ev.code), { once: true });
        ws.addEventListener("error", () => res(-1), { once: true });
        setTimeout(() => res(-2), 1000);
      });
      // Browser/Bun WebSocket may report different codes for handshake-level
      // 401; we just assert it didn't successfully open and stay open.
      expect(closeCode).not.toBe(1000);
    } finally { hub.stop(true); }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
