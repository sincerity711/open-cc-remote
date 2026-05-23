import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { createDevice } from "../src/repos/devices.ts";
import { pairDaemon } from "../src/repos/daemons.ts";
import { makeServer } from "../src/routes.ts";

function setupServer() {
  const dir = mkdtempSync(join(tmpdir(), "ccr-dr-"));
  const db = openDb(join(dir, "h.sqlite"));
  db.prepare("INSERT INTO users (sub, created_at) VALUES (?, ?)").run("u1", 1);
  db.prepare("INSERT INTO users (sub, created_at) VALUES (?, ?)").run("u2", 1);
  const { fetch, websocket } = makeServer({ db, jwt_secret: "s", disable_auth: false, pwa_url: "/" });
  const server = Bun.serve({ port: 0, fetch, websocket });
  return {
    db, server,
    url: (path: string) => `http://localhost:${server.port}${path}`,
    cleanup: () => { server.stop(true); db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("GET /daemons lists owner's non-revoked daemons with connected=false when none registered", async () => {
  const s = setupServer();
  try {
    const dev = createDevice(s.db, "u1", "browser", null, 60_000);
    pairDaemon(s.db, "d1", "u1", "{}", "alpha");
    pairDaemon(s.db, "d2", "u2", "{}", "beta");
    const res = await fetch(s.url("/daemons"), { headers: { authorization: `Bearer ${dev.bearer}` } });
    expect(res.status).toBe(200);
    const list = await res.json() as Array<{ daemon_id: string; connected: boolean; hostname: string | null }>;
    expect(list.map((d) => d.daemon_id)).toEqual(["d1"]);
    expect(list[0]).toMatchObject({ hostname: "alpha", connected: false });
  } finally { s.cleanup(); }
});

test("GET /daemons without bearer returns 401", async () => {
  const s = setupServer();
  try {
    const res = await fetch(s.url("/daemons"));
    expect(res.status).toBe(401);
  } finally { s.cleanup(); }
});

test("PATCH /daemons/:id renames", async () => {
  const s = setupServer();
  try {
    const dev = createDevice(s.db, "u1", "browser", null, 60_000);
    pairDaemon(s.db, "d1", "u1", "{}", null);
    const res = await fetch(s.url("/daemons/d1"), {
      method: "PATCH",
      headers: { authorization: `Bearer ${dev.bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ display_name: "Work laptop" }),
    });
    expect(res.status).toBe(204);
    const row = s.db.query("SELECT display_name FROM daemons WHERE daemon_id = 'd1'").get() as { display_name: string };
    expect(row.display_name).toBe("Work laptop");
  } finally { s.cleanup(); }
});

test("PATCH /daemons/:id of someone else's daemon returns 404", async () => {
  const s = setupServer();
  try {
    const devMine = createDevice(s.db, "u1", "browser", null, 60_000);
    pairDaemon(s.db, "d1", "u2", "{}", null);
    const res = await fetch(s.url("/daemons/d1"), {
      method: "PATCH",
      headers: { authorization: `Bearer ${devMine.bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ display_name: "hacker" }),
    });
    expect(res.status).toBe(404);
  } finally { s.cleanup(); }
});

test("PATCH /daemons/:id with non-string display_name returns 400", async () => {
  const s = setupServer();
  try {
    const dev = createDevice(s.db, "u1", "browser", null, 60_000);
    pairDaemon(s.db, "d1", "u1", "{}", null);
    const res = await fetch(s.url("/daemons/d1"), {
      method: "PATCH",
      headers: { authorization: `Bearer ${dev.bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ display_name: 42 }),
    });
    expect(res.status).toBe(400);
  } finally { s.cleanup(); }
});

test("DELETE /daemons/:id revokes and clears jti", async () => {
  const s = setupServer();
  try {
    const dev = createDevice(s.db, "u1", "browser", null, 60_000);
    pairDaemon(s.db, "d1", "u1", "{}", null);
    s.db.prepare("UPDATE daemons SET jwt_jti = 'abc', jwt_exp = ? WHERE daemon_id = 'd1'").run(Date.now() + 60_000);
    const res = await fetch(s.url("/daemons/d1"), {
      method: "DELETE",
      headers: { authorization: `Bearer ${dev.bearer}` },
    });
    expect(res.status).toBe(204);
    const row = s.db.query("SELECT revoked_at, jwt_jti FROM daemons WHERE daemon_id = 'd1'").get() as { revoked_at: number; jwt_jti: string | null };
    expect(row.revoked_at).toBeGreaterThan(0);
    expect(row.jwt_jti).toBe(null);
  } finally { s.cleanup(); }
});

test("DELETE /daemons/:id of unknown daemon returns 404", async () => {
  const s = setupServer();
  try {
    const dev = createDevice(s.db, "u1", "browser", null, 60_000);
    const res = await fetch(s.url("/daemons/missing"), {
      method: "DELETE",
      headers: { authorization: `Bearer ${dev.bearer}` },
    });
    expect(res.status).toBe(404);
  } finally { s.cleanup(); }
});
