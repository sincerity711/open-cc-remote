# Settings Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken Settings drawer (lists wrong table, no pair-code feature, broken loading state) with a daemons-aware UI: list paired daemons with live online indicator, mint pairing codes from the PWA, and per-section tri-state error handling.

**Architecture:** Hub gains `GET/PATCH/DELETE /daemons` and `POST /pair/issue` routes backed by a new schema column (`daemons.display_name`) and a router method that exposes the in-memory connected-daemon set. PWA replaces the monolithic `useDevices` hook with three focused hooks (`useDaemons`, `usePushPrefs`, `usePairing`) wrapped in a `Resource<T>` discriminated union; `SettingsDrawer` renders each section's loading/error/ready state independently.

**Tech Stack:** Bun + TypeScript, `bun:test` for unit, Playwright for `e2e-real`. SQLite via `bun:sqlite`. React in PWA (rendered with `renderToStaticMarkup` for unit snapshots).

**Reference:** Spec at `docs/superpowers/specs/2026-05-23-settings-page-design.md` (commit `bf55688`).

---

## File Map

**Create:**
- `packages/pwa/src/hooks/types.ts` — `Resource<T>` discriminated union shared by all data hooks
- `packages/pwa/src/hooks/useDaemons.ts` — list / rename / revoke daemons + 60s poll
- `packages/pwa/src/hooks/usePairing.ts` — generate pair code + countdown state machine
- `packages/pwa/src/hooks/usePushPrefs.ts` — moved push-prefs portion of old `useDevices`
- `packages/hub/tests/daemons-routes.test.ts` — `/daemons` route coverage
- `packages/hub/tests/pair-issue.test.ts` — `/pair/issue` route coverage
- `packages/pwa/tests/useDaemons.test.tsx` — hook coverage
- `packages/pwa/tests/usePairing.test.tsx` — pairing state machine
- `packages/pwa/tests/usePushPrefs.test.tsx` — push-prefs hook
- `e2e-real/tests/20-pair-from-pwa.test.ts` — end-to-end PWA pair-code flow

**Modify:**
- `packages/hub/src/schema.ts` — append migration v2 (`ALTER TABLE daemons ADD COLUMN display_name`)
- `packages/hub/src/repos/daemons.ts` — add `listDaemonsByOwner`, `renameDaemon`, `revokeDaemonAuthorized`
- `packages/hub/src/router.ts` — add `getConnectedDaemonIds()` and `closeDaemonConnection(id)`
- `packages/hub/src/routes.ts` — add `/daemons`, `/daemons/:id`, `/pair/issue` handlers
- `packages/pwa/src/hooks/useDevices.ts` — delete file; consumers move to new hooks
- `packages/pwa/src/screens/SettingsDrawer.tsx` — new props; per-section tri-state; pair-code box state machine
- `packages/pwa/src/RealApp.tsx` — rewire to new hooks
- `packages/pwa/src/demo/DemoApp.tsx` — stub data for new props
- `packages/pwa/tests/SettingsDrawer.test.tsx` — update for new props/structure
- `e2e-real/tests/13-settings-drawer.test.ts` — assert daemon row (not device row); update rename target

**Untouched:** `packages/proto`, `packages/daemon`, `packages/plugin`, push subscribe path, IAS auth, all other e2e scenarios.

---

## Task 1 — Schema migration: add `daemons.display_name`

**Files:**
- Modify: `packages/hub/src/schema.ts`
- Test: `packages/hub/tests/db.test.ts` (existing — extend)

- [ ] **Step 1: Write the failing test**

Add to `packages/hub/tests/db.test.ts`:

```ts
test("daemons.display_name column exists after migrations", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-mig-"));
  const db = openDb(join(dir, "h.sqlite"));
  try {
    const cols = db.query("PRAGMA table_info(daemons)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("display_name");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

```
bun test packages/hub/tests/db.test.ts -t "display_name column"
```
Expected: FAIL — column does not exist yet.

- [ ] **Step 3: Append migration v2**

In `packages/hub/src/schema.ts`, append a second entry to `MIGRATIONS`:

```ts
  {
    version: 2,
    sql: `
      ALTER TABLE daemons ADD COLUMN display_name TEXT;
    `,
  },
```

- [ ] **Step 4: Run test to verify it passes**

```
bun test packages/hub/tests/db.test.ts
```
Expected: all green, including new test.

- [ ] **Step 5: Run the full hub test suite to confirm no regressions**

```
bun test packages/hub/
```
Expected: all green.

- [ ] **Step 6: Commit**

```
git add packages/hub/src/schema.ts packages/hub/tests/db.test.ts
git commit -m "feat(hub): add daemons.display_name column (migration v2)"
```

---

## Task 2 — Daemons repo helpers (`listDaemonsByOwner`, `renameDaemon`, `revokeDaemonAuthorized`)

**Files:**
- Modify: `packages/hub/src/repos/daemons.ts`
- Test: `packages/hub/tests/repos.test.ts` (existing — extend)

- [ ] **Step 1: Write the failing tests**

Append to `packages/hub/tests/repos.test.ts`:

```ts
import {
  pairDaemon, listDaemonsByOwner, renameDaemon, revokeDaemonAuthorized, findDaemon,
} from "../src/repos/daemons.ts";

function withDb(fn: (db: Db) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "ccr-repo-"));
  const db = openDb(join(dir, "h.sqlite"));
  try {
    db.prepare("INSERT INTO users (sub, created_at) VALUES (?, ?)").run("u1", 1);
    db.prepare("INSERT INTO users (sub, created_at) VALUES (?, ?)").run("u2", 1);
    fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("listDaemonsByOwner returns owner's non-revoked daemons sorted by paired_at desc", () => {
  withDb((db) => {
    pairDaemon(db, "d1", "u1", "{}", "alpha");
    pairDaemon(db, "d2", "u1", "{}", "beta");
    pairDaemon(db, "d3", "u2", "{}", "gamma");
    db.prepare("UPDATE daemons SET revoked_at = ? WHERE daemon_id = ?").run(Date.now(), "d2");
    const list = listDaemonsByOwner(db, "u1");
    expect(list.map((d) => d.daemon_id)).toEqual(["d1"]);
    expect(list[0]).toMatchObject({
      daemon_id: "d1",
      hostname: "alpha",
      display_name: null,
    });
  });
});

test("renameDaemon updates only owner's row", () => {
  withDb((db) => {
    pairDaemon(db, "d1", "u1", "{}", null);
    pairDaemon(db, "d2", "u2", "{}", null);
    expect(renameDaemon(db, "u1", "d1", "Work")).toBe(true);
    expect(renameDaemon(db, "u1", "d2", "Hijack")).toBe(false);
    expect(listDaemonsByOwner(db, "u1")[0]?.display_name).toBe("Work");
    expect(listDaemonsByOwner(db, "u2")[0]?.display_name).toBe(null);
  });
});

test("revokeDaemonAuthorized sets revoked_at and clears jti", () => {
  withDb((db) => {
    pairDaemon(db, "d1", "u1", "{}", null);
    db.prepare("UPDATE daemons SET jwt_jti = 'abc', jwt_exp = ? WHERE daemon_id = 'd1'").run(Date.now() + 60_000);
    expect(revokeDaemonAuthorized(db, "u1", "d1")).toBe(true);
    const row = findDaemon(db, "d1");
    expect(row?.revoked_at).toBeGreaterThan(0);
    expect(row?.jwt_jti).toBe(null);
    // Idempotent: a second revoke returns false (already revoked).
    expect(revokeDaemonAuthorized(db, "u1", "d1")).toBe(false);
  });
});

test("revokeDaemonAuthorized of someone else's daemon returns false and does not modify", () => {
  withDb((db) => {
    pairDaemon(db, "d1", "u1", "{}", null);
    expect(revokeDaemonAuthorized(db, "u2", "d1")).toBe(false);
    expect(findDaemon(db, "d1")?.revoked_at).toBe(null);
  });
});
```

If `repos.test.ts` does not already import `mkdtempSync`/`tmpdir`/`join`/`rmSync`/`openDb`/`Db`/`test`/`expect`, add them at the top.

- [ ] **Step 2: Run tests to verify they fail**

```
bun test packages/hub/tests/repos.test.ts -t "listDaemonsByOwner|renameDaemon|revokeDaemonAuthorized"
```
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement helpers**

In `packages/hub/src/repos/daemons.ts`, append:

```ts
export interface DaemonListItem {
  daemon_id: string;
  display_name: string | null;
  hostname: string | null;
  paired_at: number;
  last_seen_at: number | null;
}

export function listDaemonsByOwner(db: Db, owner_sub: string): DaemonListItem[] {
  return db.query(
    `SELECT daemon_id, display_name, hostname, paired_at, last_seen_at
     FROM daemons
     WHERE owner_sub = ? AND revoked_at IS NULL
     ORDER BY paired_at DESC`,
  ).all(owner_sub) as DaemonListItem[];
}

export function renameDaemon(
  db: Db, owner_sub: string, daemon_id: string, display_name: string,
): boolean {
  const result = db.prepare(
    "UPDATE daemons SET display_name = ? WHERE daemon_id = ? AND owner_sub = ? AND revoked_at IS NULL",
  ).run(display_name, daemon_id, owner_sub);
  return result.changes === 1;
}

export function revokeDaemonAuthorized(
  db: Db, owner_sub: string, daemon_id: string,
): boolean {
  const result = db.prepare(
    "UPDATE daemons SET revoked_at = ?, jwt_jti = NULL WHERE daemon_id = ? AND owner_sub = ? AND revoked_at IS NULL",
  ).run(Date.now(), daemon_id, owner_sub);
  return result.changes === 1;
}
```

- [ ] **Step 4: Run tests**

```
bun test packages/hub/tests/repos.test.ts
```
Expected: all green.

- [ ] **Step 5: Commit**

```
git add packages/hub/src/repos/daemons.ts packages/hub/tests/repos.test.ts
git commit -m "feat(hub): add listDaemonsByOwner / renameDaemon / revokeDaemonAuthorized"
```

---

## Task 3 — Router exposes connected set + close-connection helper

**Files:**
- Modify: `packages/hub/src/connections.ts` (add `getWs` accessor)
- Modify: `packages/hub/src/router.ts`
- Test: `packages/hub/tests/router.test.ts` (existing — extend, follow inline `new Router(dreg, preg)` pattern used throughout the file)

- [ ] **Step 1: Add `getWs` to `DaemonRegistry`**

In `packages/hub/src/connections.ts`, add to the `DaemonRegistry` class:

```ts
  getWs(daemon_id: string): W | undefined {
    return this.entries.get(daemon_id)?.ws;
  }
```

- [ ] **Step 2: Write the failing tests**

The existing `router.test.ts` constructs the router inline as `new Router(dreg, preg)` and triggers state via `router.onDaemonFrame(daemon_id, frame)` / `router.onDaemonDisconnect(daemon_id)`. Mirror that pattern. Append:

```ts
test("getConnectedDaemonIds returns currently-connected daemon ids", () => {
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const router = new Router(dreg, preg);

  expect([...router.getConnectedDaemonIds()]).toEqual([]);

  // hello frames register the daemon in the router's in-memory map.
  // The DaemonRegistry separately needs add() because closeDaemonConnection
  // pulls the ws via getWs(), but for *this* test only the router map matters.
  router.onDaemonFrame("d1", { type: "hello", hostname: "h1", epoch: 1 } as any);
  router.onDaemonFrame("d2", { type: "hello", hostname: "h2", epoch: 1 } as any);
  expect(new Set(router.getConnectedDaemonIds())).toEqual(new Set(["d1", "d2"]));

  router.onDaemonDisconnect("d1");
  expect([...router.getConnectedDaemonIds()]).toEqual(["d2"]);
});

test("closeDaemonConnection closes the underlying ws when registered + connected", () => {
  const dreg = new DaemonRegistry<{ close: (code?: number, reason?: string) => void }>();
  const preg = new PwaRegistry<unknown>();
  const router = new Router(dreg, preg);

  let closed = false;
  const wsStub = { close: () => { closed = true; } };
  dreg.add("d1", wsStub, () => {}, undefined);
  router.onDaemonFrame("d1", { type: "hello", hostname: "h1", epoch: 1 } as any);

  router.closeDaemonConnection("d1");
  expect(closed).toBe(true);
});

test("closeDaemonConnection of unknown daemon is a no-op", () => {
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const router = new Router(dreg, preg);
  expect(() => router.closeDaemonConnection("nope")).not.toThrow();
});
```

If `DaemonRegistry` / `PwaRegistry` aren't already imported at the top of `router.test.ts`, add:
```ts
import { DaemonRegistry, PwaRegistry } from "../src/connections.ts";
```

- [ ] **Step 3: Run tests to verify they fail**

```
bun test packages/hub/tests/router.test.ts -t "getConnectedDaemonIds|closeDaemonConnection"
```
Expected: FAIL — methods not defined.

- [ ] **Step 4: Implement methods on `Router`**

In `packages/hub/src/router.ts`, add public methods to the `Router` class (right after the constructor):

```ts
  public getConnectedDaemonIds(): Set<string> {
    return new Set(this.daemons.keys());
  }

  public closeDaemonConnection(daemon_id: string): void {
    if (!this.daemons.has(daemon_id)) return;
    const ws = this.daemonReg.getWs(daemon_id) as { close?: (code?: number, reason?: string) => void } | undefined;
    if (ws && typeof ws.close === "function") {
      ws.close(1008, "revoked");
    }
  }
```

`this.daemonReg` is the `DaemonRegistry<unknown>` constructor argument (existing field at `router.ts:32`). The `getWs` returns `unknown`; cast to the duck-typed close shape since the WS implementation is environment-dependent (Bun ServerWebSocket in prod, plain object in tests).

- [ ] **Step 5: Run tests**

```
bun test packages/hub/tests/router.test.ts
```
Expected: all green (existing + 3 new).

- [ ] **Step 6: Commit**

```
git add packages/hub/src/router.ts packages/hub/src/connections.ts packages/hub/tests/router.test.ts
git commit -m "feat(hub): expose getConnectedDaemonIds + closeDaemonConnection on Router"
```

---

## Task 4 — Hub routes: `GET /daemons`, `PATCH /daemons/:id`, `DELETE /daemons/:id`

**Files:**
- Modify: `packages/hub/src/routes.ts`
- Create: `packages/hub/tests/daemons-routes.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `packages/hub/tests/daemons-routes.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

```
bun test packages/hub/tests/daemons-routes.test.ts
```
Expected: FAIL — `/daemons` not handled.

- [ ] **Step 3: Add handlers in `routes.ts`**

In `packages/hub/src/routes.ts`, mirroring the existing `/devices` block (around line 166), add **after** the `/devices` PATCH/DELETE block:

```ts
    if (url.pathname === "/daemons" && req.method === "GET") {
      if (!opts.db) return new Response("not configured", { status: 503 });
      const { authenticatePwa } = await import("./auth/pwa-auth.ts");
      const auth = authenticatePwa(opts.db, req);
      if ("error" in auth) return new Response(auth.error, { status: 401 });
      const { listDaemonsByOwner } = await import("./repos/daemons.ts");
      const list = listDaemonsByOwner(opts.db, auth.owner_sub);
      const connected = router.getConnectedDaemonIds();
      const enriched = list.map((d) => ({ ...d, connected: connected.has(d.daemon_id) }));
      // Sort: connected=true first, then paired_at desc (already from repo).
      enriched.sort((a, b) => {
        if (a.connected !== b.connected) return a.connected ? -1 : 1;
        return b.paired_at - a.paired_at;
      });
      return Response.json(enriched);
    }

    {
      const m = url.pathname.match(/^\/daemons\/([^/]+)$/);
      if (m && (req.method === "PATCH" || req.method === "DELETE")) {
        if (!opts.db) return new Response("not configured", { status: 503 });
        const { authenticatePwa } = await import("./auth/pwa-auth.ts");
        const auth = authenticatePwa(opts.db, req);
        if ("error" in auth) return new Response(auth.error, { status: 401 });
        const daemon_id = decodeURIComponent(m[1]!);
        if (req.method === "PATCH") {
          try {
            const body = await req.json() as { display_name?: unknown };
            if (typeof body.display_name !== "string") {
              return new Response("bad request", { status: 400 });
            }
            const { renameDaemon } = await import("./repos/daemons.ts");
            const ok = renameDaemon(opts.db, auth.owner_sub, daemon_id, body.display_name);
            return new Response(null, { status: ok ? 204 : 404 });
          } catch (e) {
            return new Response((e as Error).message, { status: 400 });
          }
        } else {
          const { revokeDaemonAuthorized } = await import("./repos/daemons.ts");
          const ok = revokeDaemonAuthorized(opts.db, auth.owner_sub, daemon_id);
          if (ok) router.closeDaemonConnection(daemon_id);
          return new Response(null, { status: ok ? 204 : 404 });
        }
      }
    }
```

`router` is already in scope in `makeServer` (declared at line 25 of the existing file). No new options field needed.

- [ ] **Step 4: Run tests**

```
bun test packages/hub/tests/daemons-routes.test.ts
```
Expected: all green.

- [ ] **Step 5: Run full hub suite to confirm no regressions**

```
bun test packages/hub/
```
Expected: all green.

- [ ] **Step 6: Commit**

```
git add packages/hub/src/routes.ts packages/hub/tests/daemons-routes.test.ts
git commit -m "feat(hub): GET /daemons + PATCH/DELETE /daemons/:id"
```

---

## Task 5 — Hub route: `POST /pair/issue`

**Files:**
- Modify: `packages/hub/src/routes.ts`
- Create: `packages/hub/tests/pair-issue.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `packages/hub/tests/pair-issue.test.ts`:

```ts
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, exportJWK } from "jose";
import { openDb } from "../src/db.ts";
import { createDevice } from "../src/repos/devices.ts";
import { handlePair } from "../src/pair.ts";
import { makeServer } from "../src/routes.ts";

function setupServer() {
  const dir = mkdtempSync(join(tmpdir(), "ccr-pi-"));
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

test("POST /pair/issue returns code + ttl when authenticated", async () => {
  const s = setupServer();
  try {
    const dev = createDevice(s.db, "u1", "browser", null, 60_000);
    const res = await fetch(s.url("/pair/issue"), {
      method: "POST",
      headers: { authorization: `Bearer ${dev.bearer}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { code: string; expires_in_sec: number };
    expect(body.code).toMatch(/^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/);
    expect(body.expires_in_sec).toBe(300);
  } finally { s.cleanup(); }
});

test("POST /pair/issue without bearer returns 401", async () => {
  const s = setupServer();
  try {
    const res = await fetch(s.url("/pair/issue"), { method: "POST" });
    expect(res.status).toBe(401);
  } finally { s.cleanup(); }
});

test("issued code is consumable by handlePair exactly once", async () => {
  const s = setupServer();
  try {
    const dev = createDevice(s.db, "u1", "browser", null, 60_000);
    const res = await fetch(s.url("/pair/issue"), {
      method: "POST",
      headers: { authorization: `Bearer ${dev.bearer}` },
    });
    const { code } = await res.json() as { code: string };

    const { publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    const publicJwk = await exportJWK(publicKey);

    const result = await handlePair(s.db, "s", {
      code, daemon_id: "d-new", public_key_jwk: publicJwk,
    });
    expect(result.daemon_id).toBe("d-new");

    // Second use must fail.
    const { publicKey: pk2 } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    const pk2jwk = await exportJWK(pk2);
    await expect(handlePair(s.db, "s", {
      code, daemon_id: "d-second", public_key_jwk: pk2jwk,
    })).rejects.toThrow(/invalid or expired code/);
  } finally { s.cleanup(); }
});

test("issued code's metadata records issuer_sub for audit", async () => {
  const s = setupServer();
  try {
    const dev = createDevice(s.db, "u1", "browser", null, 60_000);
    const res = await fetch(s.url("/pair/issue"), {
      method: "POST",
      headers: { authorization: `Bearer ${dev.bearer}` },
    });
    const { code } = await res.json() as { code: string };
    const row = s.db.query("SELECT issuer_sub FROM pairing_codes WHERE code = ?").get(code) as { issuer_sub: string };
    expect(row.issuer_sub).toBe("u1");
  } finally { s.cleanup(); }
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
bun test packages/hub/tests/pair-issue.test.ts
```
Expected: FAIL — `/pair/issue` not handled.

- [ ] **Step 3: Add handler**

In `packages/hub/src/routes.ts`, add **before** the existing `if (url.pathname === "/pair" && req.method === "POST")` block (around line 100):

```ts
    if (url.pathname === "/pair/issue" && req.method === "POST") {
      if (!opts.db) return new Response("not configured", { status: 503 });
      const { authenticatePwa } = await import("./auth/pwa-auth.ts");
      const auth = authenticatePwa(opts.db, req);
      if ("error" in auth) return new Response(auth.error, { status: 401 });
      const { issueCode } = await import("./repos/pairing-codes.ts");
      const ttlMs = 300_000;
      const code = issueCode(opts.db, "daemon", auth.owner_sub, null, ttlMs);
      return Response.json({ code, expires_in_sec: ttlMs / 1000 });
    }
```

- [ ] **Step 4: Run tests**

```
bun test packages/hub/tests/pair-issue.test.ts
bun test packages/hub/
```
Expected: all green.

- [ ] **Step 5: Commit**

```
git add packages/hub/src/routes.ts packages/hub/tests/pair-issue.test.ts
git commit -m "feat(hub): POST /pair/issue mints a 5-min daemon code from PWA"
```

---

## Task 6 — PWA: `Resource<T>` discriminated union

**Files:**
- Create: `packages/pwa/src/hooks/types.ts`

This task has no test of its own; it's a type-only file. The next tasks depend on it.

- [ ] **Step 1: Write the file**

Create `packages/pwa/src/hooks/types.ts`:

```ts
export type Resource<T> =
  | { status: "loading" }
  | { status: "error"; error: string; retry: () => void }
  | { status: "ready"; data: T };
```

- [ ] **Step 2: Verify compile**

```
bun run --cwd packages/pwa tsc --noEmit
```
Expected: clean.

- [ ] **Step 3: Commit**

```
git add packages/pwa/src/hooks/types.ts
git commit -m "feat(pwa): add Resource<T> discriminated union for data hooks"
```

---

## Task 7 — PWA: `useDaemons` hook

**Files:**
- Create: `packages/pwa/src/hooks/useDaemons.ts`
- Create: `packages/pwa/tests/useDaemons.test.ts`

**Test approach:** This codebase tests hooks by extracting pure helpers and unit-testing those (see `packages/pwa/tests/useHub.test.ts` testing `appendEventToBuffer`). React effects/lifecycle are exercised via e2e (scenarios 13 + 20). Do NOT add `@testing-library/react` — it's not a dependency.

- [ ] **Step 1: Write the failing test for pure helpers**

Create `packages/pwa/tests/useDaemons.test.ts`:

```ts
import { test, expect } from "bun:test";
import { daemonsUrl, sortDaemons, type DaemonItem } from "../src/hooks/useDaemons";

test("daemonsUrl converts ws→http", () => {
  expect(daemonsUrl("ws://hub:7745")).toBe("http://hub:7745/daemons");
  expect(daemonsUrl("wss://hub")).toBe("https://hub/daemons");
  expect(daemonsUrl("http://hub")).toBe("http://hub/daemons");
});

test("sortDaemons puts connected=true first then paired_at desc", () => {
  const list: DaemonItem[] = [
    { daemon_id: "a", display_name: null, hostname: null, paired_at: 100, last_seen_at: null, connected: false },
    { daemon_id: "b", display_name: null, hostname: null, paired_at: 200, last_seen_at: null, connected: true },
    { daemon_id: "c", display_name: null, hostname: null, paired_at: 50, last_seen_at: null, connected: true },
    { daemon_id: "d", display_name: null, hostname: null, paired_at: 300, last_seen_at: null, connected: false },
  ];
  expect(sortDaemons(list).map((d) => d.daemon_id)).toEqual(["b", "c", "d", "a"]);
});

test("sortDaemons does not mutate input", () => {
  const list: DaemonItem[] = [
    { daemon_id: "a", display_name: null, hostname: null, paired_at: 1, last_seen_at: null, connected: false },
    { daemon_id: "b", display_name: null, hostname: null, paired_at: 2, last_seen_at: null, connected: true },
  ];
  const original = [...list];
  sortDaemons(list);
  expect(list).toEqual(original);
});
```

- [ ] **Step 2: Run test to verify it fails**

```
bun test packages/pwa/tests/useDaemons.test.ts
```
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the hook + helpers**

Create `packages/pwa/src/hooks/useDaemons.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import type { Resource } from "./types";

export interface DaemonItem {
  daemon_id: string;
  display_name: string | null;
  hostname: string | null;
  paired_at: number;
  last_seen_at: number | null;
  connected: boolean;
}

const POLL_MS = 60_000;

export function daemonsUrl(hubUrl: string): string {
  return hubUrl.replace(/^ws(s?):\/\//, "http$1://") + "/daemons";
}

function daemonItemUrl(hubUrl: string, daemon_id: string): string {
  return hubUrl.replace(/^ws(s?):\/\//, "http$1://") + `/daemons/${encodeURIComponent(daemon_id)}`;
}

export function sortDaemons(list: DaemonItem[]): DaemonItem[] {
  return [...list].sort((a, b) => {
    if (a.connected !== b.connected) return a.connected ? -1 : 1;
    return b.paired_at - a.paired_at;
  });
}

async function jsonFetch<T>(url: string, bearer: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { ...init.headers, authorization: `Bearer ${bearer}` },
  });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${url}: ${res.status}`);
  if (res.status === 204) return undefined as T;
  return await res.json() as T;
}

export interface UseDaemonsResult {
  daemons: Resource<DaemonItem[]>;
  rename: (daemon_id: string, display_name: string) => Promise<void>;
  revoke: (daemon_id: string) => Promise<void>;
  refresh: () => void;
  lastActionError: string | null;
}

export function useDaemons(
  hubUrl: string,
  bearer: string | null,
  enabled: boolean = true,
): UseDaemonsResult {
  const [daemons, setDaemons] = useState<Resource<DaemonItem[]>>({ status: "loading" });
  const [lastActionError, setLastActionError] = useState<string | null>(null);
  const bearerRef = useRef(bearer);
  bearerRef.current = bearer;

  const load = useCallback(() => {
    if (!bearerRef.current) return;
    setDaemons({ status: "loading" });
    jsonFetch<DaemonItem[]>(daemonsUrl(hubUrl), bearerRef.current)
      .then((data) => setDaemons({ status: "ready", data: sortDaemons(data) }))
      .catch((e) => setDaemons({ status: "error", error: (e as Error).message, retry: load }));
  }, [hubUrl]);

  useEffect(() => {
    if (!enabled || !bearer) return;
    load();
  }, [load, bearer, enabled]);

  useEffect(() => {
    if (!enabled || !bearer) return;
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load, bearer, enabled]);

  const rename = useCallback(async (daemon_id: string, display_name: string) => {
    if (!bearerRef.current) return;
    try {
      await jsonFetch<void>(daemonItemUrl(hubUrl, daemon_id), bearerRef.current, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ display_name }),
      });
      setLastActionError(null);
      load();
    } catch (e) {
      setLastActionError((e as Error).message);
    }
  }, [hubUrl, load]);

  const revoke = useCallback(async (daemon_id: string) => {
    if (!bearerRef.current) return;
    try {
      await jsonFetch<void>(daemonItemUrl(hubUrl, daemon_id), bearerRef.current, {
        method: "DELETE",
      });
      setLastActionError(null);
      load();
    } catch (e) {
      setLastActionError((e as Error).message);
    }
  }, [hubUrl, load]);

  return { daemons, rename, revoke, refresh: load, lastActionError };
}
```

The third `enabled` parameter lets `RealApp.tsx` gate the hook on whether the Settings drawer is open (per spec §6.2). Default `true` so existing test code paths still work.

- [ ] **Step 4: Run tests**

```
bun test packages/pwa/tests/useDaemons.test.ts
```
Expected: all green.

- [ ] **Step 5: Commit**

```
git add packages/pwa/src/hooks/useDaemons.ts packages/pwa/tests/useDaemons.test.ts
git commit -m "feat(pwa): useDaemons hook + daemonsUrl/sortDaemons helpers"
```

---

## Task 8 — PWA: `usePairing` hook

**Files:**
- Create: `packages/pwa/src/hooks/usePairing.ts`
- Create: `packages/pwa/tests/usePairing.test.ts`

**Test approach:** Same as Task 7 — extract a pure `pairingTick` state-transition function and unit-test that. The React effect just calls it on a 1 Hz timer.

- [ ] **Step 1: Write the failing test**

Create `packages/pwa/tests/usePairing.test.ts`:

```ts
import { test, expect } from "bun:test";
import { pairIssueUrl, pairingTick, type PairingState } from "../src/hooks/usePairing";

test("pairIssueUrl converts ws→http", () => {
  expect(pairIssueUrl("ws://hub:7745")).toBe("http://hub:7745/pair/issue");
  expect(pairIssueUrl("wss://hub")).toBe("https://hub/pair/issue");
});

test("pairingTick decrements remainingSec while time remains", () => {
  const state: PairingState = { status: "active", code: "ABC-XYZ", expiresAt: 10_000, remainingSec: 10 };
  const next = pairingTick(state, 3_000);
  expect(next).toEqual({
    state: { status: "active", code: "ABC-XYZ", expiresAt: 10_000, remainingSec: 7 },
    expired: false,
  });
});

test("pairingTick returns idle + expired=true at exactly expiresAt", () => {
  const state: PairingState = { status: "active", code: "ABC-XYZ", expiresAt: 10_000, remainingSec: 1 };
  const next = pairingTick(state, 10_000);
  expect(next).toEqual({ state: { status: "idle" }, expired: true });
});

test("pairingTick returns idle + expired=true when now is past expiresAt", () => {
  const state: PairingState = { status: "active", code: "ABC-XYZ", expiresAt: 10_000, remainingSec: 1 };
  const next = pairingTick(state, 12_000);
  expect(next).toEqual({ state: { status: "idle" }, expired: true });
});

test("pairingTick on non-active state is a no-op", () => {
  expect(pairingTick({ status: "idle" }, 1000)).toEqual({ state: { status: "idle" }, expired: false });
  expect(pairingTick({ status: "issuing" }, 1000)).toEqual({ state: { status: "issuing" }, expired: false });
});

test("pairingTick rounds up sub-second remainders", () => {
  // 0.5 s remaining → display "1s remaining" rather than "0s".
  const state: PairingState = { status: "active", code: "ABC-XYZ", expiresAt: 10_000, remainingSec: 1 };
  const next = pairingTick(state, 9_500);
  if (next.state.status !== "active") throw new Error("expected active");
  expect(next.state.remainingSec).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

```
bun test packages/pwa/tests/usePairing.test.ts
```
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the hook + pure helpers**

Create `packages/pwa/src/hooks/usePairing.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from "react";

export type PairingState =
  | { status: "idle" }
  | { status: "issuing" }
  | { status: "active"; code: string; expiresAt: number; remainingSec: number };

export function pairIssueUrl(hubUrl: string): string {
  return hubUrl.replace(/^ws(s?):\/\//, "http$1://") + "/pair/issue";
}

export interface PairingTickResult {
  state: PairingState;
  expired: boolean;
}

export function pairingTick(state: PairingState, now: number): PairingTickResult {
  if (state.status !== "active") return { state, expired: false };
  if (now >= state.expiresAt) return { state: { status: "idle" }, expired: true };
  const remainingSec = Math.max(1, Math.ceil((state.expiresAt - now) / 1000));
  return {
    state: { ...state, remainingSec },
    expired: false,
  };
}

export interface UsePairingResult {
  state: PairingState;
  generate: () => Promise<void>;
  cancel: () => void;
  lastError: string | null;
}

export function usePairing(
  hubUrl: string,
  bearer: string | null,
  onPaired?: () => void,
): UsePairingResult {
  const [state, setState] = useState<PairingState>({ status: "idle" });
  const [lastError, setLastError] = useState<string | null>(null);
  const issuingRef = useRef(false);
  const onPairedRef = useRef(onPaired);
  onPairedRef.current = onPaired;

  const generate = useCallback(async () => {
    if (!bearer) return;
    if (issuingRef.current) return;
    if (state.status !== "idle") return;
    issuingRef.current = true;
    setState({ status: "issuing" });
    setLastError(null);
    try {
      const res = await fetch(pairIssueUrl(hubUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}` },
      });
      if (!res.ok) throw new Error(`POST /pair/issue: ${res.status}`);
      const body = await res.json() as { code: string; expires_in_sec: number };
      const expiresAt = Date.now() + body.expires_in_sec * 1000;
      setState({
        status: "active",
        code: body.code,
        expiresAt,
        remainingSec: body.expires_in_sec,
      });
    } catch (e) {
      setLastError((e as Error).message);
      setState({ status: "idle" });
    } finally {
      issuingRef.current = false;
    }
  }, [hubUrl, bearer, state.status]);

  const cancel = useCallback(() => {
    setState({ status: "idle" });
  }, []);

  // 1Hz tick while active. Intentionally subscribe only to status — not to
  // expiresAt — so the interval is created once per active session.
  const isActive = state.status === "active";
  useEffect(() => {
    if (!isActive) return;
    const id = setInterval(() => {
      setState((prev) => {
        const result = pairingTick(prev, Date.now());
        if (result.expired) onPairedRef.current?.();
        return result.state;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [isActive]);

  return { state, generate, cancel, lastError };
}
```

The pure `pairingTick` does the work; the effect is a thin shell. `issuingRef` guards against double-`generate` races. `onPairedRef` keeps the callback fresh without re-creating the interval.

- [ ] **Step 4: Run tests**

```
bun test packages/pwa/tests/usePairing.test.ts
```
Expected: all green.

- [ ] **Step 5: Commit**

```
git add packages/pwa/src/hooks/usePairing.ts packages/pwa/tests/usePairing.test.ts
git commit -m "feat(pwa): usePairing hook with pure pairingTick state transition"
```

---

## Task 9 — PWA: `usePushPrefs` hook (split from `useDevices`)

**Files:**
- Create: `packages/pwa/src/hooks/usePushPrefs.ts`
- Create: `packages/pwa/tests/usePushPrefs.test.ts`
- Delete: `packages/pwa/src/hooks/useDevices.ts` (after Task 11 wires up replacements)

**Test approach:** Same as Task 7/8 — pure helpers only. Hook lifecycle covered by e2e scenario 13.

- [ ] **Step 1: Write the failing test**

Create `packages/pwa/tests/usePushPrefs.test.ts`:

```ts
import { test, expect } from "bun:test";
import {
  pushPrefsUrl,
  isPushPrefEnabled,
  togglePref,
  type PushPreferences,
} from "../src/hooks/usePushPrefs";

test("pushPrefsUrl converts ws→http", () => {
  expect(pushPrefsUrl("ws://hub:7745")).toBe("http://hub:7745/push/preferences");
  expect(pushPrefsUrl("wss://hub")).toBe("https://hub/push/preferences");
});

test("isPushPrefEnabled treats 'permission' as default-true", () => {
  expect(isPushPrefEnabled({}, "permission")).toBe(true);
  expect(isPushPrefEnabled({ permission: false }, "permission")).toBe(false);
  expect(isPushPrefEnabled({ permission: true }, "permission")).toBe(true);
});

test("isPushPrefEnabled treats other keys as default-false", () => {
  expect(isPushPrefEnabled({}, "offline")).toBe(false);
  expect(isPushPrefEnabled({ offline: true }, "offline")).toBe(true);
  expect(isPushPrefEnabled({ offline: false }, "offline")).toBe(false);
});

test("togglePref flips a default-true key", () => {
  const before: PushPreferences = {};
  const after = togglePref(before, "permission");
  expect(after.permission).toBe(false);
  expect(togglePref(after, "permission").permission).toBe(true);
});

test("togglePref flips a default-false key", () => {
  const before: PushPreferences = { offline: false };
  expect(togglePref(before, "offline").offline).toBe(true);
});

test("togglePref does not mutate input", () => {
  const before: PushPreferences = { offline: false };
  togglePref(before, "offline");
  expect(before.offline).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

```
bun test packages/pwa/tests/usePushPrefs.test.ts
```
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the hook + pure helpers**

Create `packages/pwa/src/hooks/usePushPrefs.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import type { Resource } from "./types";

export interface PushPreferences {
  permission?: boolean;
  offline?: boolean;
  completed?: boolean;
  idle?: boolean;
}

const PREF_DEFAULT_TRUE: ReadonlyArray<keyof PushPreferences> = ["permission"];

export function pushPrefsUrl(hubUrl: string): string {
  return hubUrl.replace(/^ws(s?):\/\//, "http$1://") + "/push/preferences";
}

export function isPushPrefEnabled(prefs: PushPreferences, key: keyof PushPreferences): boolean {
  if (PREF_DEFAULT_TRUE.includes(key)) return prefs[key] !== false;
  return prefs[key] === true;
}

export function togglePref(prefs: PushPreferences, key: keyof PushPreferences): PushPreferences {
  return { ...prefs, [key]: !isPushPrefEnabled(prefs, key) };
}

async function jsonFetch<T>(url: string, bearer: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { ...init.headers, authorization: `Bearer ${bearer}` },
  });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${url}: ${res.status}`);
  if (res.status === 204) return undefined as T;
  return await res.json() as T;
}

export interface UsePushPrefsResult {
  prefs: Resource<PushPreferences>;
  toggle: (key: keyof PushPreferences) => Promise<void>;
  lastActionError: string | null;
}

export function usePushPrefs(hubUrl: string, bearer: string | null): UsePushPrefsResult {
  const [prefs, setPrefs] = useState<Resource<PushPreferences>>({ status: "loading" });
  const [lastActionError, setLastActionError] = useState<string | null>(null);
  const bearerRef = useRef(bearer);
  bearerRef.current = bearer;

  const load = useCallback(() => {
    if (!bearerRef.current) return;
    setPrefs({ status: "loading" });
    jsonFetch<PushPreferences>(pushPrefsUrl(hubUrl), bearerRef.current)
      .then((data) => setPrefs({ status: "ready", data }))
      .catch((e) => setPrefs({ status: "error", error: (e as Error).message, retry: load }));
  }, [hubUrl]);

  useEffect(() => {
    if (!bearer) return;
    load();
  }, [load, bearer]);

  const toggle = useCallback(async (key: keyof PushPreferences) => {
    if (!bearerRef.current) return;
    if (prefs.status !== "ready") return;
    const next = togglePref(prefs.data, key);
    setPrefs({ status: "ready", data: next });
    try {
      await jsonFetch<void>(pushPrefsUrl(hubUrl), bearerRef.current, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      });
      setLastActionError(null);
    } catch (e) {
      setLastActionError((e as Error).message);
    }
  }, [hubUrl, prefs]);

  return { prefs, toggle, lastActionError };
}
```

- [ ] **Step 4: Run tests**

```
bun test packages/pwa/tests/usePushPrefs.test.ts
```
Expected: all green.

- [ ] **Step 5: Commit**

```
git add packages/pwa/src/hooks/usePushPrefs.ts packages/pwa/tests/usePushPrefs.test.ts
git commit -m "feat(pwa): usePushPrefs hook + togglePref/isPushPrefEnabled helpers"
```

---

## Task 10 — Rewrite `SettingsDrawer.tsx` for new props

**Files:**
- Modify: `packages/pwa/src/screens/SettingsDrawer.tsx`
- Modify: `packages/pwa/tests/SettingsDrawer.test.tsx`

- [ ] **Step 1: Rewrite the unit test for the new shape**

Replace the contents of `packages/pwa/tests/SettingsDrawer.test.tsx` with:

```tsx
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DaemonItem } from "../src/hooks/useDaemons";
import type { PushPreferences } from "../src/hooks/usePushPrefs";
import type { PairingState } from "../src/hooks/usePairing";
import type { Resource } from "../src/hooks/types";
import { SettingsDrawer } from "../src/screens/SettingsDrawer";

const baseProps = {
  device: "desktop" as const,
  account: { email: "alice@example.com", onSignOut: () => {} },
  onRenameDaemon: () => {},
  onRevokeDaemon: () => {},
  onTogglePref: () => {},
  onGenerateCode: () => {},
  onCancelPairing: () => {},
  appearance: "system" as const,
  onSetAppearance: () => {},
  onClose: () => {},
};

const readyDaemons: Resource<DaemonItem[]> = {
  status: "ready",
  data: [
    { daemon_id: "d1", display_name: "Work laptop", hostname: "mbp", paired_at: 0, last_seen_at: Date.now(), connected: true },
    { daemon_id: "d2", display_name: null, hostname: null, paired_at: 0, last_seen_at: null, connected: false },
  ],
};
const readyPrefs: Resource<PushPreferences> = {
  status: "ready", data: { permission: true, offline: false, completed: true, idle: false },
};
const idlePairing: PairingState = { status: "idle" };

test("renders all sections with ready data", () => {
  const markup = renderToStaticMarkup(
    <SettingsDrawer
      {...baseProps}
      daemons={readyDaemons}
      pushPrefs={readyPrefs}
      pairing={idlePairing}
    />,
  );
  expect(markup).toContain("alice@example.com");
  expect(markup).toContain("Work laptop");
  expect(markup).toContain("Online");
  expect(markup).toContain("Never connected");
  expect(markup).toContain("Permission alerts");
  // Pair-code idle
  expect(markup).toContain("Generate code");
  expect(markup).toContain("Run cc-remote pair on your machine");
});

test("daemons section shows loading", () => {
  const markup = renderToStaticMarkup(
    <SettingsDrawer
      {...baseProps}
      daemons={{ status: "loading" }}
      pushPrefs={readyPrefs}
      pairing={idlePairing}
    />,
  );
  // Loading… appears for daemons
  expect(markup.match(/Loading…/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
});

test("daemons section shows error with retry button", () => {
  const markup = renderToStaticMarkup(
    <SettingsDrawer
      {...baseProps}
      daemons={{ status: "error", error: "boom", retry: () => {} }}
      pushPrefs={readyPrefs}
      pairing={idlePairing}
    />,
  );
  expect(markup).toContain("Couldn't load");
  expect(markup).toContain("Retry");
});

test("pair-code active state shows code and copy command", () => {
  const markup = renderToStaticMarkup(
    <SettingsDrawer
      {...baseProps}
      daemons={readyDaemons}
      pushPrefs={readyPrefs}
      pairing={{ status: "active", code: "ABC-XYZ", expiresAt: Date.now() + 60_000, remainingSec: 60 }}
    />,
  );
  expect(markup).toContain("ABC-XYZ");
  expect(markup).toContain("cc-remote pair ABC-XYZ");
  expect(markup).toContain("Cancel");
});

test("does not render top-level error banner anymore", () => {
  const markup = renderToStaticMarkup(
    <SettingsDrawer
      {...baseProps}
      daemons={{ status: "error", error: "boom", retry: () => {} }}
      pushPrefs={{ status: "error", error: "boom", retry: () => {} }}
      pairing={idlePairing}
    />,
  );
  expect(markup).not.toContain("bg-danger-subtle");
});
```

- [ ] **Step 2: Run test to verify it fails**

```
bun test packages/pwa/tests/SettingsDrawer.test.tsx
```
Expected: FAIL — old `SettingsDrawer` still has old props.

- [ ] **Step 3: Rewrite `SettingsDrawer.tsx`**

Replace `packages/pwa/src/screens/SettingsDrawer.tsx` with:

```tsx
import { useState } from "react";
import { Copy, X } from "lucide-react";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import type { Device } from "../hooks/useMediaQuery";
import type { Resource } from "../hooks/types";
import type { DaemonItem } from "../hooks/useDaemons";
import type { PushPreferences } from "../hooks/usePushPrefs";
import { isPushPrefEnabled } from "../hooks/usePushPrefs";
import type { PairingState } from "../hooks/usePairing";

export type Appearance = "system" | "light" | "dark";

const PUSH_TOGGLES: ReadonlyArray<{ key: keyof PushPreferences; label: string }> = [
  { key: "permission", label: "Permission alerts" },
  { key: "offline", label: "Daemon offline (≥ 30s)" },
  { key: "completed", label: "Claude finished a turn" },
  { key: "idle", label: "Claude is idle" },
];

export interface SettingsDrawerProps {
  device: Device;
  account: { email: string; onSignOut: () => void };
  daemons: Resource<DaemonItem[]>;
  onRenameDaemon: (daemon_id: string, display_name: string) => void;
  onRevokeDaemon: (daemon_id: string) => void;
  pushPrefs: Resource<PushPreferences>;
  onTogglePref: (key: keyof PushPreferences) => void;
  pairing: PairingState;
  onGenerateCode: () => void;
  onCancelPairing: () => void;
  appearance: Appearance;
  onSetAppearance: (mode: Appearance) => void;
  daemonActionError?: string | null;
  pushActionError?: string | null;
  pairingError?: string | null;
  onClose: () => void;
}

export function SettingsDrawer(props: SettingsDrawerProps) {
  const {
    device, account, daemons, onRenameDaemon, onRevokeDaemon,
    pushPrefs, onTogglePref, pairing, onGenerateCode, onCancelPairing,
    appearance, onSetAppearance,
    daemonActionError, pushActionError, pairingError,
    onClose,
  } = props;

  return (
    <div
      className="bg-overlay fixed inset-0 z-50 flex"
      data-testid="settings-drawer"
      onClick={onClose}
    >
      <aside
        className={cn(
          "bg-surface shadow-sheet ml-auto h-full overflow-y-auto p-4",
          device === "mobile" ? "w-full" : "w-[420px]",
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Settings</h2>
          <Button aria-label="Close settings" onClick={onClose} size="icon" variant="ghost">
            <X className="size-4" />
          </Button>
        </div>

        <div className="mt-5 space-y-5">
          <Section title="Account">
            <p className="text-muted-foreground text-sm">{account.email}</p>
            <Button className="mt-3" onClick={account.onSignOut} size="sm" variant="secondary">
              Sign out
            </Button>
          </Section>

          <Section title="Paired daemons">
            <ResourceView
              resource={daemons}
              empty={<p className="text-muted-foreground text-sm">No daemons paired.</p>}
              render={(list) => list.map((d) => (
                <DaemonRow key={d.daemon_id} daemon={d} onRename={onRenameDaemon} onRevoke={onRevokeDaemon} />
              ))}
            />
            {daemonActionError && (
              <p className="text-danger mt-2 text-sm">{daemonActionError}</p>
            )}
          </Section>

          <Section title="Pair new daemon">
            <PairCodeBox
              pairing={pairing}
              onGenerate={onGenerateCode}
              onCancel={onCancelPairing}
              error={pairingError ?? null}
            />
          </Section>

          <Section title="Notifications">
            <ResourceView
              resource={pushPrefs}
              render={(prefs) => PUSH_TOGGLES.map(({ key, label }) => (
                <ToggleRow
                  key={key}
                  enabled={isPushPrefEnabled(prefs, key)}
                  label={label}
                  onToggle={() => onTogglePref(key)}
                />
              ))}
            />
            {pushActionError && (
              <p className="text-danger mt-2 text-sm">{pushActionError}</p>
            )}
          </Section>

          <Section title="Appearance">
            <div className="grid grid-cols-3 gap-2">
              {(["system", "light", "dark"] as const).map((mode) => (
                <Button
                  key={mode}
                  onClick={() => onSetAppearance(mode)}
                  size="sm"
                  variant={appearance === mode ? "default" : "secondary"}
                >
                  {mode.charAt(0).toUpperCase() + mode.slice(1)}
                </Button>
              ))}
            </div>
          </Section>
        </div>
      </aside>
    </div>
  );
}

function Section({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function ResourceView<T extends Array<unknown> | object>({
  resource, render, empty,
}: {
  resource: Resource<T>;
  render: (data: T) => React.ReactNode;
  empty?: React.ReactNode;
}) {
  if (resource.status === "loading") {
    return <p className="text-muted-foreground text-sm">Loading…</p>;
  }
  if (resource.status === "error") {
    return (
      <p className="text-muted-foreground text-sm">
        Couldn't load.{" "}
        <button
          className="text-primary underline"
          onClick={() => resource.retry()}
          type="button"
        >
          Retry
        </button>
      </p>
    );
  }
  if (Array.isArray(resource.data) && resource.data.length === 0 && empty) {
    return <>{empty}</>;
  }
  return <>{render(resource.data)}</>;
}

function DaemonRow({
  daemon, onRename, onRevoke,
}: {
  daemon: DaemonItem;
  onRename: (daemon_id: string, display_name: string) => void;
  onRevoke: (daemon_id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(daemon.display_name ?? "");

  return (
    <div className="rounded-card border-border bg-surface mb-2 border p-3">
      {editing ? (
        <div className="flex gap-2">
          <input
            autoFocus
            className="border-border bg-muted h-9 min-w-0 flex-1 rounded-md border px-3 text-sm outline-none"
            onChange={(e) => setDraft(e.target.value)}
            value={draft}
          />
          <Button onClick={() => { onRename(daemon.daemon_id, draft); setEditing(false); }} size="sm">
            Save
          </Button>
          <Button onClick={() => setEditing(false)} size="sm" variant="secondary">
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="flex items-center gap-2 truncate font-semibold">
              <StatusDot connected={daemon.connected} />
              {daemon.display_name ?? "(unnamed)"}
            </p>
            <p className="text-muted-foreground truncate font-mono text-xs">
              {daemon.daemon_id}
              {daemon.hostname ? ` @ ${daemon.hostname}` : ""}
            </p>
            <p className="text-muted-foreground text-xs" title={daemon.last_seen_at ? new Date(daemon.last_seen_at).toLocaleString() : ""}>
              {statusLabel(daemon)}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button onClick={() => setEditing(true)} size="sm" variant="secondary">
              Rename
            </Button>
            <Button
              onClick={() => {
                if (confirm("Revoke this daemon? It will be signed out.")) onRevoke(daemon.daemon_id);
              }}
              size="sm"
              variant="secondary"
            >
              Revoke
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusDot({ connected }: { connected: boolean }) {
  return (
    <span
      aria-label={connected ? "online" : "offline"}
      className={cn("inline-block size-2 rounded-full", connected ? "bg-success" : "bg-muted-foreground")}
    />
  );
}

function statusLabel(d: DaemonItem): string {
  if (d.connected) return "Online";
  if (d.last_seen_at == null) return "Never connected";
  const ageSec = Math.floor((Date.now() - d.last_seen_at) / 1000);
  if (ageSec < 30) return "Just now";
  return `Last seen ${formatRelative(ageSec)}`;
}

function formatRelative(sec: number): string {
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function PairCodeBox({
  pairing, onGenerate, onCancel, error,
}: {
  pairing: PairingState;
  onGenerate: () => void;
  onCancel: () => void;
  error: string | null;
}) {
  return (
    <div className="rounded-card border-border bg-muted border p-4 text-center">
      <p className="text-muted-foreground text-sm">Pairing code</p>
      <p className="mt-3 font-mono text-2xl font-semibold">
        {pairing.status === "active" ? pairing.code : "— —"}
      </p>
      {pairing.status === "idle" && (
        <>
          <Button className="mt-3" onClick={onGenerate} size="sm">
            Generate code
          </Button>
          <p className="text-muted-foreground mt-2 text-xs">
            Run cc-remote pair on your machine
          </p>
        </>
      )}
      {pairing.status === "issuing" && (
        <Button className="mt-3" disabled size="sm">
          Generating…
        </Button>
      )}
      {pairing.status === "active" && (
        <>
          <Button
            className="mt-3"
            onClick={() => copyCommand(`cc-remote pair ${pairing.code}`)}
            size="sm"
            variant="secondary"
          >
            <Copy className="size-4" />
            Copy "cc-remote pair {pairing.code}"
          </Button>
          <p className="text-muted-foreground mt-2 text-xs">
            Expires in {formatCountdown(pairing.remainingSec)}{" "}
            <button className="text-primary underline" onClick={onCancel} type="button">
              Cancel
            </button>
          </p>
        </>
      )}
      {error && <p className="text-danger mt-2 text-sm">{error}</p>}
    </div>
  );
}

function ToggleRow({
  enabled, label, onToggle,
}: {
  enabled: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      className="rounded-card border-border bg-surface mb-2 flex w-full items-center justify-between border p-3 text-left"
      onClick={onToggle}
      type="button"
    >
      <span className="text-sm">{label}</span>
      <span
        className={cn(
          "rounded-full px-2 py-1 text-xs font-semibold",
          enabled ? "bg-success-subtle text-success" : "bg-muted text-muted-foreground",
        )}
      >
        {enabled ? "On" : "Off"}
      </span>
    </button>
  );
}

function formatCountdown(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function copyCommand(cmd: string) {
  if (typeof navigator !== "undefined" && navigator.clipboard) {
    navigator.clipboard.writeText(cmd).catch(() => {});
  }
}
```

- [ ] **Step 4: Run unit tests**

```
bun test packages/pwa/tests/SettingsDrawer.test.tsx
```
Expected: all green.

- [ ] **Step 5: Typecheck**

```
bun run --cwd packages/pwa tsc --noEmit
```
Expected: clean. (Will likely have errors in `RealApp.tsx` / `DemoApp.tsx` because they still pass old props — that's fixed in Task 11. Tolerate those specific errors only; everything else must be clean.)

- [ ] **Step 6: Commit**

```
git add packages/pwa/src/screens/SettingsDrawer.tsx packages/pwa/tests/SettingsDrawer.test.tsx
git commit -m "feat(pwa): rewrite SettingsDrawer for daemons + tri-state + pair-code box"
```

---

## Task 11 — Wire `RealApp.tsx` and `DemoApp.tsx`; delete `useDevices.ts`

**Files:**
- Modify: `packages/pwa/src/RealApp.tsx`
- Modify: `packages/pwa/src/demo/DemoApp.tsx`
- Delete: `packages/pwa/src/hooks/useDevices.ts`

- [ ] **Step 1: Read current `RealApp.tsx` to find the SettingsDrawer mounting block**

```
grep -n "SettingsDrawer\|useDevices" packages/pwa/src/RealApp.tsx
```

- [ ] **Step 2: Update `RealApp.tsx`**

Replace the `useDevices(...)` call with three new hooks, and the `<SettingsDrawer …>` JSX with the new prop shape.

Old block (around line 162):
```tsx
<SettingsDrawer
  device={device}
  account={…}
  devices={…}
  onRenameDevice={…}
  onRevokeDevice={…}
  pushPrefs={…}
  onTogglePref={…}
  appearance={…}
  onSetAppearance={…}
  error={…}
  onClose={…}
/>
```

Replace with:
```tsx
const daemonsHook = useDaemons(hubUrl, bearer, showSettings);
const pushHook = usePushPrefs(hubUrl, bearer);
const pairingHook = usePairing(hubUrl, bearer, daemonsHook.refresh);

…

<SettingsDrawer
  device={device}
  account={{ email: account?.email ?? "signed in", onSignOut }}
  daemons={daemonsHook.daemons}
  onRenameDaemon={daemonsHook.rename}
  onRevokeDaemon={daemonsHook.revoke}
  pushPrefs={pushHook.prefs}
  onTogglePref={pushHook.toggle}
  pairing={pairingHook.state}
  onGenerateCode={pairingHook.generate}
  onCancelPairing={pairingHook.cancel}
  daemonActionError={daemonsHook.lastActionError}
  pushActionError={pushHook.lastActionError}
  pairingError={pairingHook.lastError}
  appearance={appearance}
  onSetAppearance={setAppearance}
  onClose={() => setShowSettings(false)}
/>
```

Update imports at the top of the file:
```tsx
import { useDaemons } from "./hooks/useDaemons";
import { usePushPrefs } from "./hooks/usePushPrefs";
import { usePairing } from "./hooks/usePairing";
```
Remove the `import { useDevices } …` line.

- [ ] **Step 3: Update `DemoApp.tsx` similarly**

Demo mode has no real hub, so use static stubs:

```tsx
const stubbedDaemons: Resource<DaemonItem[]> = {
  status: "ready",
  data: [{
    daemon_id: "demo-laptop",
    display_name: "Demo laptop",
    hostname: "demo",
    paired_at: Date.now() - 86400_000,
    last_seen_at: Date.now() - 5_000,
    connected: true,
  }],
};
const stubbedPrefs: Resource<PushPreferences> = {
  status: "ready",
  data: { permission: true, offline: true, completed: true, idle: false },
};
const idlePairing: PairingState = { status: "idle" };

…

<SettingsDrawer
  device={device}
  account={{ email: "demo@example.com", onSignOut: () => {} }}
  daemons={stubbedDaemons}
  onRenameDaemon={() => {}}
  onRevokeDaemon={() => {}}
  pushPrefs={stubbedPrefs}
  onTogglePref={() => {}}
  pairing={idlePairing}
  onGenerateCode={() => {}}
  onCancelPairing={() => {}}
  appearance={appearance}
  onSetAppearance={setAppearance}
  onClose={() => setShowSettings(false)}
/>
```

Add imports:
```tsx
import type { Resource } from "../hooks/types";
import type { DaemonItem } from "../hooks/useDaemons";
import type { PushPreferences } from "../hooks/usePushPrefs";
import type { PairingState } from "../hooks/usePairing";
```
Remove old `import { … } from "../hooks/useDevices"` if any.

- [ ] **Step 4: Delete `useDevices.ts`**

```
git rm packages/pwa/src/hooks/useDevices.ts
```

- [ ] **Step 5: Search for any leftover imports**

```
grep -rn "useDevices\|from.*hooks/useDevices" packages/pwa/src packages/pwa/tests
```
Expected: no matches. If any, fix them.

- [ ] **Step 6: Typecheck and run all PWA tests**

```
bun run --cwd packages/pwa tsc --noEmit
bun test packages/pwa/
```
Expected: all green.

- [ ] **Step 7: Commit**

```
git add packages/pwa
git commit -m "feat(pwa): wire RealApp/DemoApp to useDaemons/usePushPrefs/usePairing"
```

---

## Task 12 — Extract CORS bridge helper + update existing e2e `13-settings-drawer.test.ts`

**Files:**
- Modify: `e2e-real/helpers/pwa-browser.ts` (add `installCorsBridge` helper)
- Modify: `e2e-real/tests/13-settings-drawer.test.ts`

The CORS bridge block in `13-settings-drawer.test.ts` will be reused by the new scenario 20. Extract it first to avoid copy-paste drift.

- [ ] **Step 1: Add the helper to `pwa-browser.ts`**

Read the top of `e2e-real/helpers/pwa-browser.ts` to confirm its current exports, then append:

```ts
import type { BrowserContext } from "@playwright/test";

/**
 * Forward cross-origin REST calls to `hubBase` server-side and re-emit the
 * response with permissive CORS headers. The hub itself emits no CORS headers,
 * which is fine in production (PWA proxied via vite-dev) but breaks browser
 * tests across origins. Routes are matched against the absolute hub URL the
 * PWA fetches; OPTIONS preflights are short-circuited.
 *
 * Caller must invoke this BEFORE navigating the PWA (or reload after) since
 * mounted hooks fire `fetch()` on first render.
 */
export async function installCorsBridge(context: BrowserContext, hubBase: string): Promise<void> {
  const pattern = `${hubBase}/**`;
  await context.route(pattern, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
          "access-control-allow-headers": "authorization,content-type",
          "access-control-max-age": "600",
        },
      });
      return;
    }
    return route.fallback();
  });
  await context.route(pattern, async (route) => {
    const req = route.request();
    const url = req.url();
    // IAS auth chain (login/callback) is full-page nav — let it through.
    if (url.includes("/auth/")) return route.fallback();
    try {
      const resp = await fetch(url, {
        method: req.method(),
        headers: await req.allHeaders(),
        body: req.method() === "GET" || req.method() === "HEAD" ? undefined : req.postData() ?? undefined,
      });
      const buf = Buffer.from(await resp.arrayBuffer());
      const headers: Record<string, string> = {};
      resp.headers.forEach((v, k) => { headers[k] = v; });
      headers["access-control-allow-origin"] = "*";
      headers["access-control-allow-methods"] = "GET,POST,PUT,PATCH,DELETE,OPTIONS";
      headers["access-control-allow-headers"] = "authorization,content-type";
      await route.fulfill({ status: resp.status, headers, body: buf });
    } catch (e) {
      await route.fulfill({ status: 502, body: `bridge error: ${(e as Error).message}` });
    }
  });
}
```

If `pwa-browser.ts` already imports `BrowserContext`, skip that import line.

- [ ] **Step 2: Read the current scenario 13**

```
sed -n '1,80p' e2e-real/tests/13-settings-drawer.test.ts
```

- [ ] **Step 3: Replace inline CORS bridge with the helper call**

In `e2e-real/tests/13-settings-drawer.test.ts`:

- Add the import at the top: `import { installCorsBridge } from "../helpers/pwa-browser.ts";` (or merge into the existing `pwa-browser.ts` import line if `openPwa` is already imported from there).
- Delete the two `await session.context.route("http://localhost:7745/**", …)` blocks (the OPTIONS handler and the forwarder), and replace with:

```ts
await installCorsBridge(session.context, "http://localhost:7745");
```

The `session.page.reload()` and `home-screen.waitFor` steps stay as-is.

- [ ] **Step 4: Update assertions from devices to daemons**

Replace the existing `await sc.step("device-rename", …)` block with:

```ts
await sc.step("daemon-online-and-rename", async () => {
  const drawer = session.page.getByTestId("settings-drawer");
  // Wait for the online dot — strictly stronger than waiting for "Loading…" to disappear.
  await expect(drawer.locator('[aria-label="online"]').first()).toBeVisible({ timeout: 30_000 });

  const renameBtn = drawer.getByRole("button", { name: "Rename" }).first();
  await renameBtn.click();

  const newName = `renamed-${Date.now()}`;
  const input = drawer.locator("input").first();
  await input.fill(newName);
  await drawer.getByRole("button", { name: "Save" }).click();

  await expect(drawer.getByText(newName, { exact: false })).toBeVisible({ timeout: 10_000 });
});
```

The push-pref toggle / appearance / drawer-close steps stay as-is.

- [ ] **Step 5: Run the scenario**

```
bun test e2e-real/tests/13-settings-drawer.test.ts
```
Expected: green.

- [ ] **Step 6: Commit**

```
git add e2e-real/helpers/pwa-browser.ts e2e-real/tests/13-settings-drawer.test.ts
git commit -m "test(e2e-real): 13-settings-drawer asserts daemon row + extract installCorsBridge helper"
```

---

## Task 13 — New e2e `20-pair-from-pwa.test.ts`

**Files:**
- Create: `e2e-real/tests/20-pair-from-pwa.test.ts`

Reuses `installCorsBridge` from Task 12.

- [ ] **Step 1: Inspect existing helpers**

```
sed -n '1,40p' e2e-real/helpers/daemon.ts
sed -n '1,40p' e2e-real/helpers/admin.ts
```

The existing `pairDaemon` helper takes a `code` argument and runs `cc-remote pair`. We reuse it but with the code obtained from the PWA UI instead of from `issuePairingCode`.

- [ ] **Step 2: Write the scenario**

Create `e2e-real/tests/20-pair-from-pwa.test.ts`:

```ts
// Scenario 20 — pair a fresh daemon by minting a code from the PWA Settings UI.
// Validates: POST /pair/issue + countdown UI + cc-remote pair consuming that
// code + the new daemon appearing in the list with an Online indicator.

import { test, expect } from "@playwright/test";
import { upCompose, downCompose } from "../helpers/compose.ts";
import { openPwa, installCorsBridge } from "../helpers/pwa-browser.ts";
import { startPreview, type PreviewHandle } from "../helpers/preview-server.ts";
import { startDaemon, pairDaemon, mkStateDir, rmStateDir } from "../helpers/daemon.ts";
import { makeScenarioContext } from "../helpers/scenario.ts";
import { preflightOrThrow } from "../helpers/preflight.ts";
import { syncIfPassed } from "../helpers/sync-screenshots.ts";

let preview: PreviewHandle;

test.beforeAll(async () => {
  preflightOrThrow();
  await upCompose();
  preview = await startPreview();
});

test.afterAll(async () => {
  await preview?.stop();
  await downCompose();
});

test.afterEach(async ({}, testInfo) => {
  await syncIfPassed(testInfo, "20-pair-from-pwa");
});

test("pair a daemon end-to-end via the PWA Settings UI", async ({ page }, testInfo) => {
  test.setTimeout(180_000);

  const session = await openPwa({
    baseURL: preview.baseURL,
    hub_http: "http://localhost:7745",
    artifactsDir: testInfo.outputDir,
  });

  await installCorsBridge(session.context, "http://localhost:7745");
  await session.page.reload();
  await session.page.getByTestId("home-screen").waitFor({ timeout: 30_000 });

  const sc = makeScenarioContext({
    page: session.page,
    artifactsDir: testInfo.outputDir,
    scenarioSlug: "20-pair-from-pwa",
    projectName: testInfo.project.name,
  });

  const daemon_id = `pwa-pair-${Date.now()}`;
  const state_dir = mkStateDir(daemon_id);
  let daemonHandle: { stop: () => Promise<void> } | null = null;

  try {
    await sc.step("settings-opened", async () => {
      await session.page.getByRole("button", { name: "Open settings" }).click();
      await session.page.getByTestId("settings-drawer").waitFor({ timeout: 5_000 });
    });

    let code = "";
    await sc.step("code-generated", async () => {
      const drawer = session.page.getByTestId("settings-drawer");
      await drawer.getByRole("button", { name: "Generate code" }).click();
      // Code text appears in the pair box; format `XXX-XXX`.
      const codeLocator = drawer.locator("p.font-mono").first();
      await expect(codeLocator).toHaveText(/^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/, { timeout: 10_000 });
      code = (await codeLocator.textContent())?.trim() ?? "";
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/);
      // Copy command renders the literal `cc-remote pair <code>` string.
      await expect(drawer.getByText(`Copy "cc-remote pair ${code}"`)).toBeVisible();
    });

    await sc.step("daemon-paired-with-code", async () => {
      pairDaemon({ state_dir, hub_url: "http://localhost:7745", code, daemon_id });
      daemonHandle = await startDaemon({
        daemon_id,
        hub_url: "ws://localhost:7745",
        state_dir,
      });
    });

    await sc.step("daemon-shows-up-online", async () => {
      const drawer = session.page.getByTestId("settings-drawer");
      // Settings polls every 60s; close+reopen forces a fresh /daemons fetch.
      await session.page.getByRole("button", { name: "Close settings" }).click();
      await expect(drawer).toHaveCount(0);
      await session.page.getByRole("button", { name: "Open settings" }).click();
      await drawer.waitFor();
      await expect(drawer.getByText(daemon_id, { exact: false })).toBeVisible({ timeout: 30_000 });
      await expect(drawer.locator('[aria-label="online"]').first()).toBeVisible({ timeout: 30_000 });
    });

    await sc.step("daemon-revoked", async () => {
      const drawer = session.page.getByTestId("settings-drawer");
      // confirm() is auto-accepted via dialog handler.
      session.page.once("dialog", (d) => d.accept());
      await drawer.getByRole("button", { name: "Revoke" }).first().click();
      await expect(drawer.getByText(daemon_id, { exact: false })).toHaveCount(0, { timeout: 30_000 });
    });
  } finally {
    if (daemonHandle) await daemonHandle.stop();
    rmStateDir(state_dir);
    await session.close();
  }
});
```

- [ ] **Step 3: Run the scenario**

```
bun test e2e-real/tests/20-pair-from-pwa.test.ts
```
Expected: green. If it fails on the regex match for the code, double-check the alphabet matches `pairing-codes.ts:10` (`ABCDEFGHJKMNPQRSTUVWXYZ23456789`).

- [ ] **Step 4: Commit**

```
git add e2e-real/tests/20-pair-from-pwa.test.ts
git commit -m "test(e2e-real): 20-pair-from-pwa — mint code from UI, pair, online, revoke"
```

---

## Task 14 — Full regression + tag

- [ ] **Step 1: Run all unit tests across the repo**

```
bun test packages/
```
Expected: all green. Roughly 169 (existing) + 16 new ≈ 185 tests.

- [ ] **Step 2: Run all e2e-real scenarios**

```
bun test e2e-real/
```
Expected: scenarios 01–19 green (existing) + 20 green (new). Total wall time should remain under ~6 min budget.

- [ ] **Step 3: Update `docs/TODO.md`**

Move the "Settings page gaps" section from Pending to "Plan completed (2026-05-23)" and update the entry in the standard format used by previous DONE entries (see the chat-routing entry for shape).

- [ ] **Step 4: Tag git history**

```
git tag plan-settings-page
```

- [ ] **Step 5: Commit TODO update**

```
git add docs/TODO.md
git commit -m "docs(todo): mark settings-page plan DONE; tag plan-settings-page"
```

---

## Self-Review

**Spec coverage check:**
- §5.1 schema migration → Task 1 ✓
- §5.2 daemons repo helpers → Task 2 ✓
- §5.3 router exposes connected set → Task 3 ✓
- §5.4 routes (`/daemons` GET/PATCH/DELETE, `/pair/issue`) → Tasks 4 + 5 ✓
- §6.1 Resource<T> → Task 6 ✓
- §6.2 useDaemons + usePairing → Tasks 7 + 8 ✓
- §6.3 usePushPrefs (split from useDevices) → Task 9 ✓
- §6.4 SettingsDrawer rewrite → Task 10 ✓
- §6.5 daemon row UI w/ online dot + status label → Task 10 (DaemonRow / StatusDot / statusLabel) ✓
- §6.6 pair-code box (idle/active/issuing) → Task 10 (PairCodeBox) ✓
- §7 RealApp/DemoApp wiring → Task 11 ✓
- §8.1 hub unit (pair-issue + daemons-routes) → Tasks 4 + 5 ✓
- §8.2 PWA hooks unit → Tasks 7 + 8 + 9 + 10 ✓
- §8.3 e2e-real new scenario → Task 13 ✓
- §9 migration & rollout → Task 1 (migration) + Task 14 (regression) ✓

**Placeholder scan:** No "TBD" / "TODO" / "fill in" anywhere. All file paths absolute. All commands include expected output.

**Type consistency:** `DaemonItem` defined in `useDaemons.ts` (Task 7), reused by `SettingsDrawer.tsx` (Task 10), `RealApp.tsx` / `DemoApp.tsx` (Task 11), and tests. `Resource<T>` defined in `types.ts` (Task 6), reused everywhere. `PairingState` defined in `usePairing.ts` (Task 8), reused by `SettingsDrawer.tsx` (Task 10) and `DemoApp.tsx` (Task 11). Method names: `getConnectedDaemonIds`, `closeDaemonConnection`, `listDaemonsByOwner`, `renameDaemon`, `revokeDaemonAuthorized`, `useDaemons.refresh` — consistent across spec, plan, and tests.
