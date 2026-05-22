import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeIas } from "../../../tools/fake-ias/fake-ias.ts";
import { openDb } from "../src/db.ts";
import { loadIas } from "../src/auth/ias.ts";
import { makeServer } from "../src/routes.ts";

// ── Helpers ────────────────────────────────────────────────────────────────────

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

/**
 * Follow redirects one hop at a time, stopping when `stopWhen(url)` returns true
 * or when the response is not a redirect.
 * Returns the last response and the URL it came from.
 */
async function followRedirects(
  start: string,
  init: RequestInit = {},
  stopWhen?: (url: string) => boolean,
  maxHops = 10,
): Promise<{ res: Response; finalUrl: string }> {
  let url = start;
  for (let i = 0; i < maxHops; i++) {
    if (stopWhen && stopWhen(url)) {
      // Don't fetch this URL — return a synthetic "stop here" signal.
      // Caller will fetch separately with custom headers.
      return { res: new Response(null, { status: 0 }), finalUrl: url };
    }
    const res = await fetch(url, { ...init, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get("location");
      if (!next) return { res, finalUrl: url };
      const nextUrl = next.startsWith("http") ? next : new URL(next, url).toString();
      // Check if the NEXT url is the stop condition before following.
      if (stopWhen && stopWhen(nextUrl)) {
        return { res, finalUrl: nextUrl };
      }
      url = nextUrl;
      continue;
    }
    return { res, finalUrl: url };
  }
  throw new Error(`exceeded ${maxHops} redirects starting at ${start}`);
}

// fetch wrapper that doesn't follow redirects
async function fetch_(url: string, init: RequestInit = {}): Promise<Response> {
  return await fetch(url, { ...init, redirect: "manual" });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test("full IAS callback flow creates user+device and sets cookie", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-ias-"));

  // Pre-allocate hub port so we can register redirect_uri with fake-ias upfront.
  const hubPort = await getFreePort();
  const redirectUri = `http://localhost:${hubPort}/auth/callback`;

  const ias_server = await startFakeIas({
    port: 0,
    sub: "i060912@sap.com",
    clientId: "test-client",
    clientSecret: "test-secret",
    redirectUris: [redirectUri],
  });

  try {
    const db = openDb(join(dir, "h.sqlite"));
    const ias = await loadIas({
      issuer_url: ias_server.url,
      client_id: "test-client",
      client_secret: "test-secret",
      redirect_uri: redirectUri,
      allowed_subjects: ["i060912@sap.com"],
    });
    const { fetch, websocket } = makeServer({ db, ias });
    const hub = Bun.serve({ port: hubPort, fetch, websocket });

    try {
      // Follow the full OIDC authorization code flow from /auth/login through
      // fake-ias interactions, stopping just before the hub's /auth/callback.
      // We stop before hitting /auth/callback so we can inject a User-Agent header.
      const { finalUrl: callbackUrl } = await followRedirects(
        `http://localhost:${hub.port}/auth/login`,
        {},
        (url) => url.includes("/auth/callback"),
      );

      expect(callbackUrl).toContain("/auth/callback");
      expect(callbackUrl).toContain("code=");

      // Hit the hub callback with a real User-Agent so uaShortName returns "Mac".
      const cbRes = await fetch_(callbackUrl, {
        headers: { "user-agent": "Test/1 Macintosh" },
      });
      expect(cbRes.status).toBe(302);
      expect(cbRes.headers.get("location")).toMatch(/^\/#bearer=/);
      const cookie = cbRes.headers.get("set-cookie")!;
      expect(cookie).toMatch(/^cc_session=ccr_/);
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");

      // DB row was created.
      const userRow = db
        .query("SELECT sub FROM users WHERE sub = ?")
        .get("i060912@sap.com") as { sub: string } | null;
      expect(userRow?.sub).toBe("i060912@sap.com");
      const deviceRow = db
        .query(
          "SELECT owner_sub, display_name FROM devices WHERE owner_sub = ?",
        )
        .get("i060912@sap.com") as {
        owner_sub: string;
        display_name: string;
      } | null;
      expect(deviceRow?.owner_sub).toBe("i060912@sap.com");
      expect(deviceRow?.display_name).toBe("Mac");
    } finally {
      hub.stop(true);
      db.close();
    }
  } finally {
    await ias_server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("callback rejects subject not in allowed_subjects", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-ias-"));

  const hubPort = await getFreePort();
  const redirectUri = `http://localhost:${hubPort}/auth/callback`;

  const ias_server = await startFakeIas({
    port: 0,
    sub: "stranger@example.com",
    clientId: "test-client",
    clientSecret: "test-secret",
    redirectUris: [redirectUri],
  });

  try {
    const db = openDb(join(dir, "h.sqlite"));
    const ias = await loadIas({
      issuer_url: ias_server.url,
      client_id: "test-client",
      client_secret: "test-secret",
      redirect_uri: redirectUri,
      allowed_subjects: ["i060912@sap.com"],
    });
    const { fetch, websocket } = makeServer({ db, ias });
    const hub = Bun.serve({ port: hubPort, fetch, websocket });

    try {
      // Follow all redirects (login → fake-ias interactions → hub callback).
      // The hub callback should reject the disallowed subject with 401.
      const { res, finalUrl } = await followRedirects(
        `http://localhost:${hub.port}/auth/login`,
        {},
        undefined,
        15,
      );
      expect(res.status).toBe(401);
    } finally {
      hub.stop(true);
      db.close();
    }
  } finally {
    await ias_server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
