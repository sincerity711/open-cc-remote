// packages/hub/tests/push-topics-routes.test.ts
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { createDevice } from "../src/repos/devices.ts";
import { addPushSub } from "../src/repos/push-subs.ts";
import { setSubscription } from "../src/repos/topic-subscriptions.ts";
import { setDndSettings } from "../src/repos/dnd.ts";
import { makeServer } from "../src/routes.ts";

function setupServer() {
  const dir = mkdtempSync(join(tmpdir(), "ccr-topics-routes-"));
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

// ── Task 2: GET /push/topics ──────────────────────────────────────────────────

test("GET /push/topics returns 4 topic metadata entries with default flags", async () => {
  const s = setupServer();
  try {
    const c = createDevice(s.db, "u1", "iPhone", null, 60_000);
    addPushSub(s.db, c.device_id, "https://x", "p", "a");
    const res = await fetch(s.url("/push/topics"), { headers: { authorization: `Bearer ${c.bearer}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as { topics: Array<{ id: string; default_enabled: boolean; bypass_dnd: boolean }> };
    expect(body.topics.map((t) => t.id).sort()).toEqual(["completed", "idle", "offline", "permission"]);
    const permission = body.topics.find((t) => t.id === "permission")!;
    expect(permission.default_enabled).toBe(true);
    expect(permission.bypass_dnd).toBe(true);
  } finally { s.cleanup(); }
});

test("GET /push/topics returns subscriptions and DND from DB", async () => {
  const s = setupServer();
  try {
    const c = createDevice(s.db, "u1", "iPhone", null, 60_000);
    addPushSub(s.db, c.device_id, "https://x", "p", "a");
    setSubscription(s.db, c.device_id, "idle", "", true);
    setSubscription(s.db, c.device_id, "permission", "d-1", false);
    setDndSettings(s.db, c.device_id, { enabled: true, start_hh_mm: "22:00", end_hh_mm: "07:00", timezone: "UTC" });
    const res = await fetch(s.url("/push/topics"), { headers: { authorization: `Bearer ${c.bearer}` } });
    const body = await res.json() as {
      subscriptions: Array<{ topic_id: string; daemon_id: string | null; enabled: boolean }>;
      dnd: { enabled: boolean; start_hh_mm: string | null; end_hh_mm: string | null; timezone: string | null };
    };
    expect(body.subscriptions).toContainEqual({ topic_id: "idle", daemon_id: null, enabled: true });
    expect(body.subscriptions).toContainEqual({ topic_id: "permission", daemon_id: "d-1", enabled: false });
    expect(body.dnd).toEqual({ enabled: true, start_hh_mm: "22:00", end_hh_mm: "07:00", timezone: "UTC" });
  } finally { s.cleanup(); }
});

test("GET /push/topics returns dnd null shape when never set", async () => {
  const s = setupServer();
  try {
    const c = createDevice(s.db, "u1", "iPhone", null, 60_000);
    addPushSub(s.db, c.device_id, "https://x", "p", "a");
    const res = await fetch(s.url("/push/topics"), { headers: { authorization: `Bearer ${c.bearer}` } });
    const body = await res.json() as { dnd: { enabled: boolean } };
    expect(body.dnd.enabled).toBe(false);
  } finally { s.cleanup(); }
});

test("GET /push/topics requires bearer", async () => {
  const s = setupServer();
  try {
    const res = await fetch(s.url("/push/topics"));
    expect(res.status).toBe(401);
  } finally { s.cleanup(); }
});

// ── Task 3: PUT/DELETE /push/topics/subscriptions ─────────────────────────────

test("PUT /push/topics/subscriptions upserts a default-level row (daemon_id=null)", async () => {
  const s = setupServer();
  try {
    const c = createDevice(s.db, "u1", "iPhone", null, 60_000);
    addPushSub(s.db, c.device_id, "https://x", "p", "a");
    const res = await fetch(s.url("/push/topics/subscriptions"), {
      method: "PUT",
      headers: { authorization: `Bearer ${c.bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ topic_id: "idle", daemon_id: null, enabled: true }),
    });
    expect(res.status).toBe(204);
    const got = await fetch(s.url("/push/topics"), { headers: { authorization: `Bearer ${c.bearer}` } }).then((r) => r.json()) as {
      subscriptions: Array<{ topic_id: string; daemon_id: string | null; enabled: boolean }>;
    };
    expect(got.subscriptions).toContainEqual({ topic_id: "idle", daemon_id: null, enabled: true });
  } finally { s.cleanup(); }
});

test("PUT /push/topics/subscriptions upserts a daemon-specific override", async () => {
  const s = setupServer();
  try {
    const c = createDevice(s.db, "u1", "iPhone", null, 60_000);
    addPushSub(s.db, c.device_id, "https://x", "p", "a");
    const res = await fetch(s.url("/push/topics/subscriptions"), {
      method: "PUT",
      headers: { authorization: `Bearer ${c.bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ topic_id: "idle", daemon_id: "d-1", enabled: false }),
    });
    expect(res.status).toBe(204);
    const got = await fetch(s.url("/push/topics"), { headers: { authorization: `Bearer ${c.bearer}` } }).then((r) => r.json()) as {
      subscriptions: Array<{ topic_id: string; daemon_id: string | null; enabled: boolean }>;
    };
    expect(got.subscriptions).toContainEqual({ topic_id: "idle", daemon_id: "d-1", enabled: false });
  } finally { s.cleanup(); }
});

test("PUT rejects unknown topic_id with 400", async () => {
  const s = setupServer();
  try {
    const c = createDevice(s.db, "u1", "iPhone", null, 60_000);
    addPushSub(s.db, c.device_id, "https://x", "p", "a");
    const res = await fetch(s.url("/push/topics/subscriptions"), {
      method: "PUT",
      headers: { authorization: `Bearer ${c.bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ topic_id: "nope", enabled: true }),
    });
    expect(res.status).toBe(400);
  } finally { s.cleanup(); }
});

test("DELETE /push/topics/subscriptions removes a row, reverts to lower fallback", async () => {
  const s = setupServer();
  try {
    const c = createDevice(s.db, "u1", "iPhone", null, 60_000);
    addPushSub(s.db, c.device_id, "https://x", "p", "a");
    setSubscription(s.db, c.device_id, "idle", "d-1", true);
    const res = await fetch(s.url("/push/topics/subscriptions"), {
      method: "DELETE",
      headers: { authorization: `Bearer ${c.bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ topic_id: "idle", daemon_id: "d-1" }),
    });
    expect(res.status).toBe(204);
    const got = await fetch(s.url("/push/topics"), { headers: { authorization: `Bearer ${c.bearer}` } }).then((r) => r.json()) as {
      subscriptions: Array<{ topic_id: string; daemon_id: string | null }>;
    };
    expect(got.subscriptions.find((r) => r.topic_id === "idle" && r.daemon_id === "d-1")).toBeUndefined();
  } finally { s.cleanup(); }
});

// ── Task 4: PUT /push/dnd ─────────────────────────────────────────────────────

test("PUT /push/dnd persists settings", async () => {
  const s = setupServer();
  try {
    const c = createDevice(s.db, "u1", "iPhone", null, 60_000);
    addPushSub(s.db, c.device_id, "https://x", "p", "a");
    const res = await fetch(s.url("/push/dnd"), {
      method: "PUT",
      headers: { authorization: `Bearer ${c.bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, start_hh_mm: "22:00", end_hh_mm: "07:00", timezone: "UTC" }),
    });
    expect(res.status).toBe(204);
    const got = await fetch(s.url("/push/topics"), { headers: { authorization: `Bearer ${c.bearer}` } }).then((r) => r.json()) as { dnd: object };
    expect(got.dnd).toEqual({ enabled: true, start_hh_mm: "22:00", end_hh_mm: "07:00", timezone: "UTC" });
  } finally { s.cleanup(); }
});

test("PUT /push/dnd rejects bad HH:MM format", async () => {
  const s = setupServer();
  try {
    const c = createDevice(s.db, "u1", "iPhone", null, 60_000);
    addPushSub(s.db, c.device_id, "https://x", "p", "a");
    const res = await fetch(s.url("/push/dnd"), {
      method: "PUT",
      headers: { authorization: `Bearer ${c.bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, start_hh_mm: "25:00", end_hh_mm: "07:00", timezone: "UTC" }),
    });
    expect(res.status).toBe(400);
  } finally { s.cleanup(); }
});

test("PUT /push/dnd rejects unknown timezone", async () => {
  const s = setupServer();
  try {
    const c = createDevice(s.db, "u1", "iPhone", null, 60_000);
    addPushSub(s.db, c.device_id, "https://x", "p", "a");
    const res = await fetch(s.url("/push/dnd"), {
      method: "PUT",
      headers: { authorization: `Bearer ${c.bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, start_hh_mm: "22:00", end_hh_mm: "07:00", timezone: "Mars/Olympus" }),
    });
    expect(res.status).toBe(400);
  } finally { s.cleanup(); }
});
