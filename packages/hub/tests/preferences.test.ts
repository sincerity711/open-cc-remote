import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { createDevice } from "../src/repos/devices.ts";
import { addPushSub, getPreferences, setPreferences, findSubsByOwner } from "../src/repos/push-subs.ts";
import { setSubscription, listSubscriptions } from "../src/repos/topic-subscriptions.ts";
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
    // Shim returns the 2 baseline topic keys using registry defaults.
    const body = await res.json() as Record<string, boolean>;
    expect(body.permission).toBe(true);   // default_enabled=true
    expect(body.idle).toBe(false);
    // The legacy completed/offline keys are no longer surfaced.
    expect(body.completed).toBeUndefined();
    expect(body.offline).toBeUndefined();
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
    // PUT now writes to topic_subscriptions; verify via listSubscriptions.
    const rows = listSubscriptions(s.db, c.device_id).filter((r) => r.daemon_id === null);
    expect(rows).toContainEqual({ topic_id: "permission", daemon_id: null, enabled: false });
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

test("PUT /push/preferences writes to topic_subscriptions and is observable via GET /push/topics", async () => {
  const s = setupServer();
  try {
    const c = createDevice(s.db, "u1", "iPhone", null, 60_000);
    addPushSub(s.db, c.device_id, "https://x", "p", "a");
    await fetch(s.url("/push/preferences"), {
      method: "PUT",
      headers: { authorization: `Bearer ${c.bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ permission: false, idle: true }),
    });
    const rows = listSubscriptions(s.db, c.device_id).filter((r) => r.daemon_id === null);
    expect(rows).toContainEqual({ topic_id: "permission", daemon_id: null, enabled: false });
    expect(rows).toContainEqual({ topic_id: "idle",       daemon_id: null, enabled: true  });
  } finally { s.cleanup(); }
});

test("GET /push/preferences reflects topic_subscriptions for surviving keys", async () => {
  const s = setupServer();
  try {
    const c = createDevice(s.db, "u1", "iPhone", null, 60_000);
    addPushSub(s.db, c.device_id, "https://x", "p", "a");
    setSubscription(s.db, c.device_id, "idle", "", true);
    const res = await fetch(s.url("/push/preferences"), { headers: { authorization: `Bearer ${c.bearer}` } });
    const body = await res.json() as Record<string, boolean>;
    // Returns currently-set keys; permission default-true is folded in.
    expect(body.permission).toBe(true);
    expect(body.idle).toBe(true);
  } finally { s.cleanup(); }
});
