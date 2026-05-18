import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeIas } from "../../../tools/fake-ias/fake-ias.ts";
import { openDb } from "../src/db.ts";
import { loadIas } from "../src/auth/ias.ts";
import { makeServer } from "../src/routes.ts";

test("full IAS callback flow creates user+device and sets cookie", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-ias-"));
  const ias_server = await startFakeIas({ port: 0, sub: "i060912@sap.com" });

  try {
    const db = openDb(join(dir, "h.sqlite"));
    const ias = await loadIas({
      issuer_url: ias_server.url,
      client_id: "test-client",
      client_secret: "test-secret",
      redirect_uri: "http://localhost:0/auth/callback",
      allowed_subjects: ["i060912@sap.com"],
    });
    const { fetch, websocket } = makeServer({ db, ias });
    const hub = Bun.serve({ port: 0, fetch, websocket });
    // Update redirect_uri now that we know hub port.
    ias.config.redirect_uri = `http://localhost:${hub.port}/auth/callback`;

    try {
      // 1. GET /auth/login → expect 302 to fake-IAS authorize.
      const loginRes = await fetch_(`http://localhost:${hub.port}/auth/login`);
      expect(loginRes.status).toBe(302);
      const authorizeUrl = loginRes.headers.get("location")!;
      expect(authorizeUrl.startsWith(ias_server.url + "/authorize")).toBe(true);

      // 2. GET fake-IAS authorize → expect 302 to /auth/callback with code.
      const authRes = await fetch_(authorizeUrl);
      expect(authRes.status).toBe(302);
      const callbackUrl = authRes.headers.get("location")!;

      // 3. GET /auth/callback?code=... → expect 302 to / with cookie.
      const cbRes = await fetch_(callbackUrl, { headers: { "user-agent": "Test/1 Macintosh" } });
      expect(cbRes.status).toBe(302);
      expect(cbRes.headers.get("location")).toBe("/");
      const cookie = cbRes.headers.get("set-cookie")!;
      expect(cookie).toMatch(/^cc_session=ccr_/);
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");

      // 4. DB row was created.
      const userRow = db.query("SELECT sub FROM users WHERE sub = ?").get("i060912@sap.com") as { sub: string } | null;
      expect(userRow?.sub).toBe("i060912@sap.com");
      const deviceRow = db.query("SELECT owner_sub, display_name FROM devices WHERE owner_sub = ?").get("i060912@sap.com") as { owner_sub: string; display_name: string } | null;
      expect(deviceRow?.owner_sub).toBe("i060912@sap.com");
      expect(deviceRow?.display_name).toBe("Mac");
    } finally {
      hub.stop(true);
      db.close();
    }
  } finally {
    ias_server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("callback rejects subject not in allowed_subjects", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-ias-"));
  const ias_server = await startFakeIas({ port: 0, sub: "stranger@example.com" });
  try {
    const db = openDb(join(dir, "h.sqlite"));
    const ias = await loadIas({
      issuer_url: ias_server.url,
      client_id: "test-client",
      client_secret: "x",
      redirect_uri: "http://localhost:0/auth/callback",
      allowed_subjects: ["i060912@sap.com"],
    });
    const { fetch, websocket } = makeServer({ db, ias });
    const hub = Bun.serve({ port: 0, fetch, websocket });
    ias.config.redirect_uri = `http://localhost:${hub.port}/auth/callback`;

    try {
      const r1 = await fetch_(`http://localhost:${hub.port}/auth/login`);
      const r2 = await fetch_(r1.headers.get("location")!);
      const r3 = await fetch_(r2.headers.get("location")!);
      expect(r3.status).toBe(401);
    } finally {
      hub.stop(true);
      db.close();
    }
  } finally {
    ias_server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

// fetch wrapper that doesn't follow redirects
async function fetch_(url: string, init: RequestInit = {}): Promise<Response> {
  return await fetch(url, { ...init, redirect: "manual" });
}
