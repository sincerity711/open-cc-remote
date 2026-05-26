# Push Topics — Plan 02: Hub HTTP API + Service Worker + Real Payloads

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the new push-topic data via HTTP, replace stub payload builders with real notification copy + dedup tags, and switch the service worker to render server-built bodies. Keep `/push/preferences` working as a backward-compat shim for one release.

**Architecture:** Add `/push/topics` (GET + sub PUT/DELETE) and `/push/dnd` (PUT) routes to `routes.ts`. Fill in `build_payload`/`build_tag` for the four topics with the strings + tag templates from the spec. Rewrite `public/sw.js` to render `data.body`/`data.tag` directly. The legacy `/push/preferences` GET/PUT translate to/from `topic_subscriptions` so existing PWA builds keep working.

**Tech Stack:** Bun + bun:sqlite + TypeScript. Service worker is plain JS.

**Spec reference:** `docs/superpowers/specs/2026-05-25-push-topics-design.md`

**Depends on:** Plan 01 (`plan-push-topics-01-foundation` tag).

**Independence:** After this plan, the hub serves both the new and the legacy push API. The PWA still renders the old four-toggle UI (Plan 03 swaps it). Real notifications shown by `sw.js` now use server-built copy. Existing e2e scenarios stay green.

---

## File map

| Path | What |
|---|---|
| `packages/hub/src/push-topics.ts` | replace stub `build_payload`/`build_tag` with real implementations |
| `packages/hub/src/routes.ts` | add `/push/topics` GET, `/push/topics/subscriptions` PUT/DELETE, `/push/dnd` PUT; rewrite `/push/preferences` GET/PUT to read/write through new tables |
| `packages/pwa/public/sw.js` | render `data.title`/`data.body`/`data.tag`/`data.require_interaction` directly (no per-`kind` switch) |
| `packages/hub/tests/push-topics-payloads.test.ts` | **new** — assert real `build_payload` output for each topic |
| `packages/hub/tests/push-topics-routes.test.ts` | **new** — `/push/topics`, subscriptions PUT/DELETE, `/push/dnd` PUT |
| `packages/hub/tests/preferences.test.ts` | extend — verify legacy GET/PUT now read/write through `topic_subscriptions` |
| `packages/hub/tests/router.test.ts` | extend — confirm `kind` and `tag` in dispatched payload match spec |

---

## Task 1: Real `build_payload` + `build_tag` for the four topics

**Files:**
- Modify: `packages/hub/src/push-topics.ts` (replace `stubBuild`/`stubTag` with topic-specific implementations)
- Test: `packages/hub/tests/push-topics-payloads.test.ts` (new)

The trigger contexts feeding `build_payload` are exactly the shapes router passes in Plan 01 Task 6. We type them per-topic.

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/tests/push-topics-payloads.test.ts
import { test, expect } from "bun:test";
import { getTopic } from "../src/push-topics.ts";

test("permission payload renders tool + args summary, tag uses request_id, requires interaction", () => {
  const topic = getTopic("permission");
  const p = topic.build_payload({
    daemon_id: "d-1", session_id: "sess-1", request_id: "r-99",
    tool: "Bash", args_summary: "rm -rf /tmp/x",
  });
  expect(p.kind).toBe("permission");
  expect(p.title).toBe("cc-remote");
  expect(p.body).toContain("d-1");
  expect(p.body).toContain("Bash");
  expect(p.body).toContain("rm -rf /tmp/x");
  expect(p.require_interaction).toBe(true);
  expect(topic.build_tag(p)).toBe("permission:r-99");
});

test("offline payload renders hostname + duration, tag scoped to daemon_id", () => {
  const topic = getTopic("offline");
  const p = topic.build_payload({ daemon_id: "d-1", hostname: "macbook", since_ms: 45_000 });
  expect(p.kind).toBe("offline");
  expect(p.body).toContain("macbook");
  expect(p.body).toContain("45");          // seconds
  expect(p.require_interaction).toBeFalsy();
  expect(topic.build_tag(p)).toBe("offline:d-1");
});

test("completed payload renders daemon + session, tag scoped to (daemon, session)", () => {
  const topic = getTopic("completed");
  const p = topic.build_payload({ daemon_id: "d-1", session_id: "sess-1" });
  expect(p.kind).toBe("completed");
  expect(p.body).toContain("d-1");
  expect(p.body).toContain("sess-1");
  expect(topic.build_tag(p)).toBe("completed:d-1:sess-1");
});

test("idle payload renders daemon + session, tag scoped to (daemon, session)", () => {
  const topic = getTopic("idle");
  const p = topic.build_payload({ daemon_id: "d-1", session_id: "sess-1" });
  expect(p.kind).toBe("idle");
  expect(p.body).toContain("idle");
  expect(topic.build_tag(p)).toBe("idle:d-1:sess-1");
});

test("missing optional context fields default safely", () => {
  const p = getTopic("offline").build_payload({ daemon_id: "d-1" });
  expect(p.body.length).toBeGreaterThan(0);   // does not throw / produce empty
});
```

- [ ] **Step 2: Run the test — FAIL (stub copy doesn't match assertions)**

```bash
bun test packages/hub/tests/push-topics-payloads.test.ts
```

- [ ] **Step 3: Replace stubs in `packages/hub/src/push-topics.ts`**

Replace the `stubBuild`/`stubTag` definitions and the four `build_payload`/`build_tag` references in `PUSH_TOPICS` with:

```ts
// packages/hub/src/push-topics.ts (excerpt — replace stub block)

interface PermissionCtx { daemon_id: string; session_id: string; request_id: string; tool: string; args_summary: string }
interface OfflineCtx    { daemon_id: string; hostname: string; since_ms: number }
interface SessionCtx    { daemon_id: string; session_id: string }

const permissionTopic: PushTopic = {
  id: "permission",
  title: "Permission alerts",
  description: "Claude is asking to run a tool and waiting for your approval.",
  default_enabled: true,
  bypass_dnd: true,
  build_payload(ctx) {
    const c = ctx as PermissionCtx;
    return {
      kind: "permission",
      title: "cc-remote",
      body: `${c.daemon_id} wants to run ${c.tool}\n${c.args_summary}`,
      tag: `permission:${c.request_id}`,
      daemon_id: c.daemon_id,
      session_id: c.session_id,
      request_id: c.request_id,
      require_interaction: true,
    };
  },
  build_tag: (p) => p.tag,
};

const offlineTopic: PushTopic = {
  id: "offline",
  title: "Daemon offline",
  description: "A connected daemon has been offline for at least 30 seconds.",
  default_enabled: false,
  bypass_dnd: false,
  build_payload(ctx) {
    const c = ctx as OfflineCtx;
    const seconds = Math.round((c.since_ms ?? 0) / 1000);
    return {
      kind: "offline",
      title: "cc-remote",
      body: `${c.hostname ?? c.daemon_id} has been offline for ${seconds}s`,
      tag: `offline:${c.daemon_id}`,
      daemon_id: c.daemon_id,
    };
  },
  build_tag: (p) => p.tag,
};

const completedTopic: PushTopic = {
  id: "completed",
  title: "Claude finished a turn",
  description: "Claude has finished responding in one of your sessions.",
  default_enabled: false,
  bypass_dnd: false,
  build_payload(ctx) {
    const c = ctx as SessionCtx;
    return {
      kind: "completed",
      title: "cc-remote",
      body: `${c.daemon_id} / ${c.session_id} finished a turn`,
      tag: `completed:${c.daemon_id}:${c.session_id}`,
      daemon_id: c.daemon_id,
      session_id: c.session_id,
    };
  },
  build_tag: (p) => p.tag,
};

const idleTopic: PushTopic = {
  id: "idle",
  title: "Claude is idle",
  description: "Claude is idle and waiting for input.",
  default_enabled: false,
  bypass_dnd: false,
  build_payload(ctx) {
    const c = ctx as SessionCtx;
    return {
      kind: "idle",
      title: "cc-remote",
      body: `${c.daemon_id} / ${c.session_id} is idle (waiting for input)`,
      tag: `idle:${c.daemon_id}:${c.session_id}`,
      daemon_id: c.daemon_id,
      session_id: c.session_id,
    };
  },
  build_tag: (p) => p.tag,
};

export const PUSH_TOPICS: ReadonlyArray<PushTopic> = [
  permissionTopic, offlineTopic, completedTopic, idleTopic,
];
```

Delete the leftover `stubBuild` / `stubTag` declarations.

- [ ] **Step 4: Run tests — PASS**

```bash
bun test packages/hub/tests/push-topics-payloads.test.ts packages/hub/tests/push-topics-registry.test.ts packages/hub/tests/push-dispatch.test.ts packages/hub/tests/router.test.ts
```

Expected: all green. (The router tests already check `kind` and `request_id`; they remain valid.)

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/push-topics.ts packages/hub/tests/push-topics-payloads.test.ts
git commit -m "feat(hub): real notification copy + dedup tags for the 4 baseline topics"
```

---

## Task 2: `GET /push/topics` route

**Files:**
- Modify: `packages/hub/src/routes.ts` (add new route block before the existing `/push/preferences` block)
- Test: `packages/hub/tests/push-topics-routes.test.ts` (new)

Returns `{ topics: TopicMeta[], subscriptions: SubRow[], dnd: DndSettings }` for the authenticated device.

- [ ] **Step 1: Write the failing test**

```ts
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
      dnd: { enabled: boolean; timezone: string | null };
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
```

- [ ] **Step 2: Run the test — FAIL (route does not exist; expect 404 / wrong shape)**

```bash
bun test packages/hub/tests/push-topics-routes.test.ts
```

- [ ] **Step 3: Add `/push/topics` GET route**

In `packages/hub/src/routes.ts`, before the `/push/preferences` GET block, insert:

```ts
if (url.pathname === "/push/topics" && req.method === "GET") {
  if (!opts.db) return new Response("not configured", { status: 503 });
  const { authenticatePwa } = await import("./auth/pwa-auth.ts");
  const auth = authenticatePwa(opts.db, req);
  if ("error" in auth) return new Response(auth.error, { status: 401 });
  const { PUSH_TOPICS } = await import("./push-topics.ts");
  const { listSubscriptions } = await import("./repos/topic-subscriptions.ts");
  const { getDndSettings } = await import("./repos/dnd.ts");
  return Response.json({
    topics: PUSH_TOPICS.map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      default_enabled: t.default_enabled,
      bypass_dnd: t.bypass_dnd,
    })),
    subscriptions: listSubscriptions(opts.db, auth.device_id),
    dnd: getDndSettings(opts.db, auth.device_id) ?? {
      enabled: false, start_hh_mm: null, end_hh_mm: null, timezone: null,
    },
  });
}
```

- [ ] **Step 4: Run the test — PASS**

```bash
bun test packages/hub/tests/push-topics-routes.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/routes.ts packages/hub/tests/push-topics-routes.test.ts
git commit -m "feat(hub): GET /push/topics returns metadata + subscriptions + dnd"
```

---

## Task 3: `PUT` and `DELETE /push/topics/subscriptions`

**Files:**
- Modify: `packages/hub/src/routes.ts`
- Modify: `packages/hub/tests/push-topics-routes.test.ts` (append cases)

PUT body `{ topic_id, daemon_id?: string | null, enabled: boolean }` upserts. DELETE same body (without `enabled`) removes the row, reverting to the lower fallback.

- [ ] **Step 1: Append failing tests**

```ts
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
```

- [ ] **Step 2: Run the tests — FAIL**

```bash
bun test packages/hub/tests/push-topics-routes.test.ts
```

- [ ] **Step 3: Add the routes to `routes.ts`**

```ts
if (url.pathname === "/push/topics/subscriptions" && (req.method === "PUT" || req.method === "DELETE")) {
  if (!opts.db) return new Response("not configured", { status: 503 });
  const { authenticatePwa } = await import("./auth/pwa-auth.ts");
  const auth = authenticatePwa(opts.db, req);
  if ("error" in auth) return new Response(auth.error, { status: 401 });
  try {
    const body = await req.json() as { topic_id?: string; daemon_id?: string | null; enabled?: boolean };
    if (typeof body.topic_id !== "string") return new Response("topic_id required", { status: 400 });
    const { getTopic } = await import("./push-topics.ts");
    try { getTopic(body.topic_id); } catch { return new Response("unknown topic", { status: 400 }); }
    const daemon_id = body.daemon_id == null ? "" : String(body.daemon_id);
    const { setSubscription, deleteSubscription } = await import("./repos/topic-subscriptions.ts");
    if (req.method === "PUT") {
      if (typeof body.enabled !== "boolean") return new Response("enabled required", { status: 400 });
      setSubscription(opts.db, auth.device_id, body.topic_id, daemon_id, body.enabled);
    } else {
      deleteSubscription(opts.db, auth.device_id, body.topic_id, daemon_id);
    }
    return new Response(null, { status: 204 });
  } catch (e) {
    return new Response((e as Error).message, { status: 400 });
  }
}
```

- [ ] **Step 4: Run tests — PASS**

```bash
bun test packages/hub/tests/push-topics-routes.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/routes.ts packages/hub/tests/push-topics-routes.test.ts
git commit -m "feat(hub): PUT/DELETE /push/topics/subscriptions"
```

---

## Task 4: `PUT /push/dnd`

**Files:**
- Modify: `packages/hub/src/routes.ts`
- Modify: `packages/hub/tests/push-topics-routes.test.ts`

Validates IANA timezone via `Intl.supportedValuesOf("timeZone")` and `HH:MM` format.

- [ ] **Step 1: Append failing tests**

```ts
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
```

- [ ] **Step 2: Run — FAIL**

```bash
bun test packages/hub/tests/push-topics-routes.test.ts
```

- [ ] **Step 3: Add route**

```ts
if (url.pathname === "/push/dnd" && req.method === "PUT") {
  if (!opts.db) return new Response("not configured", { status: 503 });
  const { authenticatePwa } = await import("./auth/pwa-auth.ts");
  const auth = authenticatePwa(opts.db, req);
  if ("error" in auth) return new Response(auth.error, { status: 401 });
  try {
    const body = await req.json() as {
      enabled?: boolean; start_hh_mm?: string | null; end_hh_mm?: string | null; timezone?: string | null;
    };
    if (typeof body.enabled !== "boolean") return new Response("enabled required", { status: 400 });
    const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (body.enabled) {
      if (!body.start_hh_mm || !HHMM.test(body.start_hh_mm)) return new Response("bad start_hh_mm", { status: 400 });
      if (!body.end_hh_mm   || !HHMM.test(body.end_hh_mm))   return new Response("bad end_hh_mm",   { status: 400 });
      if (!body.timezone) return new Response("timezone required", { status: 400 });
      // Intl.supportedValuesOf available in Bun's V8; fall back to constructor probe.
      try { new Intl.DateTimeFormat("en-GB", { timeZone: body.timezone }); }
      catch { return new Response("bad timezone", { status: 400 }); }
    }
    const { setDndSettings } = await import("./repos/dnd.ts");
    setDndSettings(opts.db, auth.device_id, {
      enabled: body.enabled,
      start_hh_mm: body.start_hh_mm ?? null,
      end_hh_mm:   body.end_hh_mm   ?? null,
      timezone:    body.timezone    ?? null,
    });
    return new Response(null, { status: 204 });
  } catch (e) {
    return new Response((e as Error).message, { status: 400 });
  }
}
```

- [ ] **Step 4: Run tests — PASS**

```bash
bun test packages/hub/tests/push-topics-routes.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/routes.ts packages/hub/tests/push-topics-routes.test.ts
git commit -m "feat(hub): PUT /push/dnd with HH:MM and timezone validation"
```

---

## Task 5: Backward-compat shim for `/push/preferences`

**Files:**
- Modify: `packages/hub/src/routes.ts` (replace existing `/push/preferences` handlers' bodies; URL stays the same)
- Modify: `packages/hub/tests/preferences.test.ts` (test legacy → new translation)

Old PWA builds POST `{permission, offline, completed, idle: bool}` to `/push/preferences`. We translate read/write through `topic_subscriptions` (daemon_id='') so they continue to work for one release.

- [ ] **Step 1: Update existing tests + add new ones**

Append to `packages/hub/tests/preferences.test.ts`:

```ts
import { listSubscriptions } from "../src/repos/topic-subscriptions.ts";

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

test("GET /push/preferences reflects topic_subscriptions for the four legacy keys", async () => {
  const s = setupServer();
  try {
    const c = createDevice(s.db, "u1", "iPhone", null, 60_000);
    addPushSub(s.db, c.device_id, "https://x", "p", "a");
    setSubscription(s.db, c.device_id, "completed", "", true);
    const res = await fetch(s.url("/push/preferences"), { headers: { authorization: `Bearer ${c.bearer}` } });
    const body = await res.json() as Record<string, boolean>;
    // Legacy contract: returns currently-set keys; permission default-true is folded in.
    expect(body.permission).toBe(true);
    expect(body.completed).toBe(true);
  } finally { s.cleanup(); }
});
```

(Keep the `setSubscription` import at the top of the test file.)

- [ ] **Step 2: Run — FAIL (current handlers use `getPreferences`/`setPreferences`)**

```bash
bun test packages/hub/tests/preferences.test.ts
```

- [ ] **Step 3: Replace the GET/PUT handler bodies**

In `packages/hub/src/routes.ts`, locate the `/push/preferences` GET (~line 76) and PUT (~line 85) blocks and replace their bodies:

```ts
// GET /push/preferences (legacy)
if (url.pathname === "/push/preferences" && req.method === "GET") {
  if (!opts.db) return new Response("not configured", { status: 503 });
  const { authenticatePwa } = await import("./auth/pwa-auth.ts");
  const auth = authenticatePwa(opts.db, req);
  if ("error" in auth) return new Response(auth.error, { status: 401 });
  const { listSubscriptions } = await import("./repos/topic-subscriptions.ts");
  const { PUSH_TOPICS } = await import("./push-topics.ts");
  const out: Record<string, boolean> = {};
  // Defaults from registry first
  for (const t of PUSH_TOPICS) out[t.id] = t.default_enabled;
  // Device-default rows override
  for (const r of listSubscriptions(opts.db, auth.device_id)) {
    if (r.daemon_id === null) out[r.topic_id] = r.enabled;
  }
  // Legacy contract returned only the 4 baseline keys; the registry currently has those 4.
  return Response.json(out);
}

// PUT /push/preferences (legacy)
if (url.pathname === "/push/preferences" && req.method === "PUT") {
  if (!opts.db) return new Response("not configured", { status: 503 });
  const { authenticatePwa } = await import("./auth/pwa-auth.ts");
  const auth = authenticatePwa(opts.db, req);
  if ("error" in auth) return new Response(auth.error, { status: 401 });
  try {
    const body = await req.json() as Record<string, boolean>;
    const { setSubscription } = await import("./repos/topic-subscriptions.ts");
    const { getTopic } = await import("./push-topics.ts");
    for (const [k, v] of Object.entries(body)) {
      if (typeof v !== "boolean") continue;
      try { getTopic(k); } catch { continue; }   // ignore unknown legacy keys silently
      setSubscription(opts.db, auth.device_id, k, "", v);
    }
    return new Response(null, { status: 204 });
  } catch (e) {
    return new Response((e as Error).message, { status: 400 });
  }
}
```

The old `getPreferences` / `setPreferences` calls in `packages/hub/src/repos/push-subs.ts` are no longer used by routes. Leave the functions in place — they are still imported by tests for setup convenience. The `push_subs.preferences` column stays populated (current `addPushSub` writes a default JSON), which is harmless.

- [ ] **Step 4: Run tests — PASS**

```bash
bun test packages/hub/tests/preferences.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/routes.ts packages/hub/tests/preferences.test.ts
git commit -m "feat(hub): /push/preferences legacy shim translates to topic_subscriptions"
```

---

## Task 6: Service worker — render server-built body/tag

**Files:**
- Modify: `packages/pwa/public/sw.js`

Strip the `if (data.kind === ...)` branches; honour `data.title`, `data.body`, `data.tag`, `data.require_interaction` from the server payload directly.

- [ ] **Step 1: Replace `packages/pwa/public/sw.js`**

```js
// packages/pwa/public/sw.js
// Receives Web Push events, shows OS notification, opens PWA on click.
// Notification copy is built server-side (see hub push-topics.ts build_payload).

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}

  const title = data.title || "cc-remote";
  const body = data.body || "";
  const tag = data.tag || "cc-remote";
  const requireInteraction = data.require_interaction === true;

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      data,
      requireInteraction,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const c of clientList) {
        if ("focus" in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow("/");
    }),
  );
});
```

- [ ] **Step 2: Smoke-test the existing scenario that exercises the SW path**

```bash
bun test e2e-real/tests/11-offline-push.test.ts
```

Expected: green. (Scenario 11 only exercises subscription registration; it does not assert on body text. The SW change is rendering-only.)

- [ ] **Step 3: Verify the PWA still builds**

```bash
bun run --filter @cc-remote/pwa build
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add packages/pwa/public/sw.js
git commit -m "feat(pwa): service worker renders server-built notification body/tag (no per-kind switch)"
```

---

## Task 7: Final regression sweep + tag

**Files:** none

- [ ] **Step 1: Full hub test suite**

```bash
bun test packages/hub/
```

- [ ] **Step 2: Existing e2e smoke (subset most likely to detect push regression)**

```bash
bun test e2e-real/tests/11-offline-push.test.ts e2e-real/tests/13-settings-drawer.test.ts e2e-real/tests/02-permission-relay.test.ts
```

Expected: green.

- [ ] **Step 3: Typecheck both touched packages**

```bash
bun run --filter @cc-remote/hub typecheck && bun run --filter @cc-remote/pwa typecheck
```

- [ ] **Step 4: Tag**

```bash
git tag plan-push-topics-02-api
```

---

## Done criteria

- ✅ `build_payload`/`build_tag` filled in for the 4 topics matching the spec's tag table.
- ✅ `GET /push/topics` returns metadata + subscriptions + DND.
- ✅ `PUT/DELETE /push/topics/subscriptions` work with both `daemon_id=null` and concrete daemon ids.
- ✅ `PUT /push/dnd` validates HH:MM + timezone.
- ✅ Legacy `/push/preferences` GET/PUT translate to `topic_subscriptions`; old `preferences.test.ts` still green.
- ✅ `sw.js` is per-kind-free; renders `data.title`/`data.body`/`data.tag`.
- ✅ Existing e2e smoke green; tag `plan-push-topics-02-api`.

---

## Self-review

- **Spec coverage (Plan 02 scope):** §HTTP API ✓ Tasks 2/3/4; backward compat ✓ Task 5; §Service worker ✓ Task 6; §Tag strategy + payload bodies ✓ Task 1.
- **Out of Plan 02 scope (Plan 03):** PWA `usePushTopics` hook, SettingsDrawer rewrite. The shim ensures the existing PWA UI continues to work in the meantime.
- **Placeholders:** none.
- **Type consistency:** `daemon_id` is `null` over the wire and `''` in the DB — the route translates at the boundary (Task 3). `Intl.DateTimeFormat` constructor probe is used instead of `Intl.supportedValuesOf` to avoid version dependency (Task 4 note).
- **Test completeness:** every new route has positive + negative cases (auth, validation, missing fields). Legacy `/push/preferences` has both read and write coverage that exercises the new translation.
