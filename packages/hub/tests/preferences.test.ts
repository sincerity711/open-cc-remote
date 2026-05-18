import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { createDevice } from "../src/repos/devices.ts";
import { addPushSub, getPreferences, setPreferences, findSubsByOwner } from "../src/repos/push-subs.ts";
import { makeServer } from "../src/routes.ts";

function setupServer() {
  const dir = mkdtempSync(join(tmpdir(), "ccr-pref-"));
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

test("default preferences are { permission: true }", async () => {
  const s = setupServer();
  try {
    const c = createDevice(s.db, "u1", "iPhone", null, 60_000);
    addPushSub(s.db, c.device_id, "https://x", "p", "a");
    expect(getPreferences(s.db, c.device_id)).toEqual({ permission: true });
  } finally { s.cleanup(); }
});

test("setPreferences merges with existing", async () => {
  const s = setupServer();
  try {
    const c = createDevice(s.db, "u1", "iPhone", null, 60_000);
    addPushSub(s.db, c.device_id, "https://x", "p", "a");
    setPreferences(s.db, c.device_id, { permission: false });
    expect(getPreferences(s.db, c.device_id)).toEqual({ permission: false });
  } finally { s.cleanup(); }
});

test("GET /push/preferences returns current prefs", async () => {
  const s = setupServer();
  try {
    const c = createDevice(s.db, "u1", "iPhone", null, 60_000);
    addPushSub(s.db, c.device_id, "https://x", "p", "a");
    const res = await fetch(s.url("/push/preferences"), { headers: { authorization: `Bearer ${c.bearer}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ permission: true });
  } finally { s.cleanup(); }
});

test("PUT /push/preferences updates prefs", async () => {
  const s = setupServer();
  try {
    const c = createDevice(s.db, "u1", "iPhone", null, 60_000);
    addPushSub(s.db, c.device_id, "https://x", "p", "a");
    const put = await fetch(s.url("/push/preferences"), {
      method: "PUT",
      headers: { authorization: `Bearer ${c.bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ permission: false }),
    });
    expect(put.status).toBe(204);
    expect(getPreferences(s.db, c.device_id)).toEqual({ permission: false });
  } finally { s.cleanup(); }
});

test("findSubsByOwner returns preferences in each row", async () => {
  const s = setupServer();
  try {
    const c = createDevice(s.db, "u1", "iPhone", null, 60_000);
    addPushSub(s.db, c.device_id, "https://x", "p", "a");
    setPreferences(s.db, c.device_id, { permission: false });
    const subs = findSubsByOwner(s.db, "u1");
    expect(subs).toHaveLength(1);
    expect(subs[0]!.preferences).toEqual({ permission: false });
  } finally { s.cleanup(); }
});
