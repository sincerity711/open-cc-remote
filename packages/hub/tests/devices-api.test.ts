import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { createDevice } from "../src/repos/devices.ts";
import { addPushSub, findSubsByOwner } from "../src/repos/push-subs.ts";
import { makeServer } from "../src/routes.ts";

function setupServer() {
  const dir = mkdtempSync(join(tmpdir(), "ccr-d-"));
  const db = openDb(join(dir, "h.sqlite"));
  db.prepare("INSERT INTO users (sub, created_at) VALUES (?, ?)").run("u1", 1);
  const { fetch, websocket } = makeServer({ db, jwt_secret: "s", disable_auth: false, pwa_url: "/" });
  const server = Bun.serve({ port: 0, fetch, websocket });
  return {
    db, server,
    url: (path: string) => `http://localhost:${server.port}${path}`,
    cleanup: () => { server.stop(true); db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("GET /devices lists current user's devices", async () => {
  const s = setupServer();
  try {
    const c1 = createDevice(s.db, "u1", "iPhone", null, 60_000);
    const c2 = createDevice(s.db, "u1", "Mac", null, 60_000);
    const res = await fetch(s.url("/devices"), { headers: { authorization: `Bearer ${c1.bearer}` } });
    expect(res.status).toBe(200);
    const list = await res.json() as Array<{ device_id: string; display_name: string }>;
    expect(list).toHaveLength(2);
    expect(list.map((d) => d.display_name).sort()).toEqual(["Mac", "iPhone"]);
  } finally { s.cleanup(); }
});

test("GET /devices without bearer returns 401", async () => {
  const s = setupServer();
  try {
    const res = await fetch(s.url("/devices"));
    expect(res.status).toBe(401);
  } finally { s.cleanup(); }
});

test("PATCH /devices/:id renames", async () => {
  const s = setupServer();
  try {
    const c = createDevice(s.db, "u1", "Old Name", null, 60_000);
    const res = await fetch(s.url(`/devices/${c.device_id}`), {
      method: "PATCH",
      headers: { authorization: `Bearer ${c.bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ display_name: "iPhone 16 Pro" }),
    });
    expect(res.status).toBe(204);
    const row = s.db.query("SELECT display_name FROM devices WHERE device_id = ?").get(c.device_id) as { display_name: string };
    expect(row.display_name).toBe("iPhone 16 Pro");
  } finally { s.cleanup(); }
});

test("PATCH /devices/:id of someone else's device returns 404", async () => {
  const s = setupServer();
  try {
    s.db.prepare("INSERT INTO users (sub, created_at) VALUES (?, ?)").run("u2", 1);
    const cMine = createDevice(s.db, "u1", "Mine", null, 60_000);
    const cTheirs = createDevice(s.db, "u2", "Theirs", null, 60_000);
    const res = await fetch(s.url(`/devices/${cTheirs.device_id}`), {
      method: "PATCH",
      headers: { authorization: `Bearer ${cMine.bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ display_name: "hacker" }),
    });
    expect(res.status).toBe(404);
  } finally { s.cleanup(); }
});

test("DELETE /devices/:id revokes device and removes push subscription", async () => {
  const s = setupServer();
  try {
    const c = createDevice(s.db, "u1", "iPhone", null, 60_000);
    addPushSub(s.db, c.device_id, "https://fcm/x", "p", "a");

    const res = await fetch(s.url(`/devices/${c.device_id}`), {
      method: "DELETE",
      headers: { authorization: `Bearer ${c.bearer}` },
    });
    expect(res.status).toBe(204);

    const row = s.db.query("SELECT revoked_at FROM devices WHERE device_id = ?").get(c.device_id) as { revoked_at: number | null };
    expect(row.revoked_at).toBeTruthy();
    expect(findSubsByOwner(s.db, "u1")).toHaveLength(0);
  } finally { s.cleanup(); }
});
