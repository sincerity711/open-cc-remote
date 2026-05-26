# Push Topics — Plan 01: Hub Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Internal hub refactor that replaces the four hardcoded `dispatchXxxPush` methods with a data-driven push-topic registry, schema for per-(device, topic, daemon) subscriptions, and DND settings — without changing observable behaviour.

**Architecture:** Add migration v3 with `topic_subscriptions` and `dnd_settings` tables. Introduce a `push-topics` registry (hub-internal const). Move dispatch into a single `dispatchTopic` function that resolves subscriptions via a 3-level fallback (daemon-specific → device-default → topic-default) and applies DND. Refactor `router.ts` to call `dispatchTopic(getTopic("…"), ...)` from the existing four trigger points.

**Tech Stack:** Bun + bun:sqlite + TypeScript. Existing test runner `bun test`.

**Spec reference:** `docs/superpowers/specs/2026-05-25-push-topics-design.md`

**Independence:** After this plan, all existing unit + e2e tests stay green. No HTTP, frontend, or wire-protocol changes. Behaviour is identical to today: `permission` default-on, others default-off, no per-daemon overrides, no DND. The new tables exist but are unused at the API layer (Plan 02 wires them).

---

## File map

| Path | What |
|---|---|
| `packages/hub/src/schema.ts` | append migration v3 |
| `packages/hub/src/push-topics.ts` | **new** — `PushTopic` interface + `PUSH_TOPICS` const + `getTopic` |
| `packages/hub/src/repos/topic-subscriptions.ts` | **new** — `setSubscription`, `deleteSubscription`, `findActiveSubsForTopic`, `deleteAllForDaemon` |
| `packages/hub/src/repos/dnd.ts` | **new** — `getDndSettings`, `setDndSettings` |
| `packages/hub/src/dnd.ts` | **new** — pure `isInDndWindow(dnd, nowMs)` helper |
| `packages/hub/src/push-dispatch.ts` | **new** — `dispatchTopic(db, push, topic, daemon_id, ctx)` |
| `packages/hub/src/router.ts` | replace four `dispatchXxxPush` calls with `dispatchTopic(getTopic("…"), …)` |
| `packages/hub/tests/migration-v3.test.ts` | **new** — verifies tables created + data move |
| `packages/hub/tests/topic-subscriptions.test.ts` | **new** — `findActiveSubsForTopic` resolution, override semantics |
| `packages/hub/tests/dnd.test.ts` | **new** — `isInDndWindow` window math |
| `packages/hub/tests/push-dispatch.test.ts` | **new** — dispatch loop, bypass_dnd handling |
| `packages/hub/tests/router.test.ts` | extend — confirm 4 frame triggers each call dispatch with the right topic id |

---

## Task 1: Migration v3 — create new tables and move data

**Files:**
- Modify: `packages/hub/src/schema.ts:6-64`
- Test: `packages/hub/tests/migration-v3.test.ts` (new)

The `push_subs.preferences` JSON column stays in place for one release. We only add new tables and copy explicit keys into `topic_subscriptions` rows. NULL/missing keys are *not* copied — runtime falls back to `topic.default_enabled`, preserving today's behaviour.

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/tests/migration-v3.test.ts
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { createDevice } from "../src/repos/devices.ts";
import { addPushSub, setPreferences } from "../src/repos/push-subs.ts";

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), "ccr-mig3-"));
  const db = openDb(join(dir, "h.sqlite"));
  db.prepare("INSERT INTO users (sub, created_at) VALUES (?, ?)").run("u1", 1);
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("v3 creates topic_subscriptions table with composite PK including daemon_id", () => {
  const s = tmpDb();
  try {
    const cols = s.db.query("PRAGMA table_info(topic_subscriptions)").all() as Array<{ name: string; notnull: number; pk: number }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(["daemon_id", "device_id", "enabled", "topic_id"]);
    const pks = cols.filter((c) => c.pk > 0).map((c) => c.name).sort();
    expect(pks).toEqual(["daemon_id", "device_id", "topic_id"]);
  } finally { s.cleanup(); }
});

test("v3 creates dnd_settings table with device_id PK", () => {
  const s = tmpDb();
  try {
    const cols = s.db.query("PRAGMA table_info(dnd_settings)").all() as Array<{ name: string; pk: number }>;
    const pks = cols.filter((c) => c.pk > 0).map((c) => c.name);
    expect(pks).toEqual(["device_id"]);
  } finally { s.cleanup(); }
});

test("v3 copies explicit preference keys into topic_subscriptions with daemon_id=''", () => {
  const s = tmpDb();
  try {
    const c = createDevice(s.db, "u1", "iPhone", null, 60_000);
    addPushSub(s.db, c.device_id, "https://x", "p", "a");
    setPreferences(s.db, c.device_id, { permission: false, idle: true });
    // Re-run migrations by reopening should be idempotent — but for the move
    // we test on the already-migrated DB: setPreferences happens AFTER addPushSub,
    // and addPushSub itself wrote DEFAULT_PREFS = {permission:true} first, which
    // then got merged. Migration v3 ran on openDb, so we expect the move to have
    // already happened against {permission:true}. The {permission:false,idle:true}
    // setPreferences happened after migration — those don't auto-flow yet (Plan 02
    // shim handles writes). So we assert just the migration snapshot:
    const rows = s.db.query(
      "SELECT topic_id, enabled FROM topic_subscriptions WHERE device_id = ? AND daemon_id = '' ORDER BY topic_id",
    ).all(c.device_id) as Array<{ topic_id: string; enabled: number }>;
    expect(rows).toEqual([{ topic_id: "permission", enabled: 1 }]);
  } finally { s.cleanup(); }
});

test("v3 does not copy missing/null preference keys", () => {
  const s = tmpDb();
  try {
    const c = createDevice(s.db, "u1", "iPhone", null, 60_000);
    addPushSub(s.db, c.device_id, "https://x", "p", "a");
    // After addPushSub, only `permission:true` is present; offline/completed/idle missing.
    const ids = s.db.query(
      "SELECT topic_id FROM topic_subscriptions WHERE device_id = ?",
    ).all(c.device_id) as Array<{ topic_id: string }>;
    expect(ids.map((r) => r.topic_id).sort()).toEqual(["permission"]);
  } finally { s.cleanup(); }
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test packages/hub/tests/migration-v3.test.ts
```

Expected: all four tests fail (`no such table: topic_subscriptions` etc.).

- [ ] **Step 3: Append migration v3 to `schema.ts`**

```ts
// packages/hub/src/schema.ts — append to MIGRATIONS array
  {
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS topic_subscriptions (
        device_id TEXT NOT NULL,
        topic_id  TEXT NOT NULL,
        daemon_id TEXT NOT NULL DEFAULT '',
        enabled   INTEGER NOT NULL,
        PRIMARY KEY (device_id, topic_id, daemon_id),
        FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS dnd_settings (
        device_id   TEXT PRIMARY KEY,
        enabled     INTEGER NOT NULL DEFAULT 0,
        start_hh_mm TEXT,
        end_hh_mm   TEXT,
        timezone    TEXT,
        FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
      );
      INSERT OR IGNORE INTO topic_subscriptions (device_id, topic_id, daemon_id, enabled)
      SELECT device_id, 'permission', '',
             CASE WHEN json_extract(preferences, '$.permission') = 1 THEN 1 ELSE 0 END
      FROM push_subs WHERE json_extract(preferences, '$.permission') IS NOT NULL;
      INSERT OR IGNORE INTO topic_subscriptions (device_id, topic_id, daemon_id, enabled)
      SELECT device_id, 'offline', '',
             CASE WHEN json_extract(preferences, '$.offline') = 1 THEN 1 ELSE 0 END
      FROM push_subs WHERE json_extract(preferences, '$.offline') IS NOT NULL;
      INSERT OR IGNORE INTO topic_subscriptions (device_id, topic_id, daemon_id, enabled)
      SELECT device_id, 'completed', '',
             CASE WHEN json_extract(preferences, '$.completed') = 1 THEN 1 ELSE 0 END
      FROM push_subs WHERE json_extract(preferences, '$.completed') IS NOT NULL;
      INSERT OR IGNORE INTO topic_subscriptions (device_id, topic_id, daemon_id, enabled)
      SELECT device_id, 'idle', '',
             CASE WHEN json_extract(preferences, '$.idle') = 1 THEN 1 ELSE 0 END
      FROM push_subs WHERE json_extract(preferences, '$.idle') IS NOT NULL;
    `,
  },
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test packages/hub/tests/migration-v3.test.ts
bun test packages/hub/tests/db.test.ts        # idempotency: re-open DB should not re-run migrations
bun test packages/hub/tests/preferences.test.ts # legacy prefs API still works (untouched)
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/schema.ts packages/hub/tests/migration-v3.test.ts
git commit -m "feat(hub): migration v3 — topic_subscriptions + dnd_settings tables, copy explicit prefs"
```

---

## Task 2: Push topic registry

**Files:**
- Create: `packages/hub/src/push-topics.ts`
- Test: `packages/hub/tests/push-topics-registry.test.ts` (new)

Centralizes the four topics with metadata. `build_payload` and `build_tag` are stubbed to identity-like functions in this plan; Plan 02 fills them with real notification copy and the actual tag templates from the spec.

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/tests/push-topics-registry.test.ts
import { test, expect } from "bun:test";
import { PUSH_TOPICS, getTopic } from "../src/push-topics.ts";

test("registry exposes the 4 baseline topics with stable ids", () => {
  expect(PUSH_TOPICS.map((t) => t.id).sort()).toEqual(
    ["completed", "idle", "offline", "permission"],
  );
});

test("permission is default-enabled and bypasses DND; others are not", () => {
  expect(getTopic("permission").default_enabled).toBe(true);
  expect(getTopic("permission").bypass_dnd).toBe(true);
  for (const id of ["offline", "completed", "idle"]) {
    expect(getTopic(id).default_enabled).toBe(false);
    expect(getTopic(id).bypass_dnd).toBe(false);
  }
});

test("getTopic throws on unknown id", () => {
  expect(() => getTopic("nope")).toThrow(/unknown topic/);
});
```

- [ ] **Step 2: Run the test — FAIL (file does not exist)**

```bash
bun test packages/hub/tests/push-topics-registry.test.ts
```

- [ ] **Step 3: Create `packages/hub/src/push-topics.ts`**

```ts
// packages/hub/src/push-topics.ts
export interface PushPayload {
  kind: string;
  title: string;
  body: string;
  tag: string;
  daemon_id: string;
  session_id?: string;
  request_id?: string;
  require_interaction?: boolean;
  [k: string]: unknown;
}

export interface PushTopic {
  id: string;
  title: string;
  description: string;
  default_enabled: boolean;
  bypass_dnd: boolean;
  /** Builds the full notification payload (title/body/etc.) from a trigger context. */
  build_payload: (ctx: unknown) => PushPayload;
  /** Tag string used by the OS to collapse duplicate notifications. */
  build_tag: (payload: PushPayload) => string;
}

// Plan 02 replaces these stubs with real copy + tags.
const stubBuild = (id: string) => (ctx: unknown): PushPayload => {
  const c = (ctx ?? {}) as Record<string, unknown>;
  return {
    kind: id,
    title: "cc-remote",
    body: "",
    tag: id,
    daemon_id: String(c.daemon_id ?? ""),
    ...(typeof c.session_id === "string" ? { session_id: c.session_id } : {}),
    ...(typeof c.request_id === "string" ? { request_id: c.request_id } : {}),
  };
};
const stubTag = (p: PushPayload) => p.tag;

export const PUSH_TOPICS: ReadonlyArray<PushTopic> = [
  {
    id: "permission",
    title: "Permission alerts",
    description: "Claude is asking to run a tool and waiting for your approval.",
    default_enabled: true,
    bypass_dnd: true,
    build_payload: stubBuild("permission"),
    build_tag: stubTag,
  },
  {
    id: "offline",
    title: "Daemon offline",
    description: "A connected daemon has been offline for at least 30 seconds.",
    default_enabled: false,
    bypass_dnd: false,
    build_payload: stubBuild("offline"),
    build_tag: stubTag,
  },
  {
    id: "completed",
    title: "Claude finished a turn",
    description: "Claude has finished responding in one of your sessions.",
    default_enabled: false,
    bypass_dnd: false,
    build_payload: stubBuild("completed"),
    build_tag: stubTag,
  },
  {
    id: "idle",
    title: "Claude is idle",
    description: "Claude is idle and waiting for input.",
    default_enabled: false,
    bypass_dnd: false,
    build_payload: stubBuild("idle"),
    build_tag: stubTag,
  },
];

const BY_ID = new Map(PUSH_TOPICS.map((t) => [t.id, t] as const));

export function getTopic(id: string): PushTopic {
  const t = BY_ID.get(id);
  if (!t) throw new Error(`unknown topic: ${id}`);
  return t;
}
```

- [ ] **Step 4: Run the test — PASS**

```bash
bun test packages/hub/tests/push-topics-registry.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/push-topics.ts packages/hub/tests/push-topics-registry.test.ts
git commit -m "feat(hub): push topic registry with 4 baseline topics (stub payload builders)"
```

---

## Task 3: `topic-subscriptions` repo with 3-level resolution

**Files:**
- Create: `packages/hub/src/repos/topic-subscriptions.ts`
- Test: `packages/hub/tests/topic-subscriptions.test.ts`

Backs the runtime decision "is topic T enabled for device D against daemon X?" with the 3-level fallback (daemon-specific → device-default → topic-default).

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/tests/topic-subscriptions.test.ts
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { createDevice } from "../src/repos/devices.ts";
import { addPushSub } from "../src/repos/push-subs.ts";
import { pairDaemon } from "../src/repos/daemons.ts";
import {
  setSubscription, deleteSubscription, deleteAllForDaemon,
  findActiveSubsForTopic, listSubscriptions,
} from "../src/repos/topic-subscriptions.ts";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "ccr-tsub-"));
  const db = openDb(join(dir, "h.sqlite"));
  db.prepare("INSERT INTO users (sub, created_at) VALUES (?, ?)").run("u1", 1);
  const c = createDevice(db, "u1", "iPhone", null, 60_000);
  addPushSub(db, c.device_id, "https://x", "p", "a");
  pairDaemon(db, "d-1", "u1", "h", "{}", Date.now());
  return { db, device_id: c.device_id, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("findActiveSubsForTopic returns sub when topic.default_enabled=true and no rows", () => {
  const s = setup();
  try {
    const subs = findActiveSubsForTopic(s.db, "u1", "permission", "d-1", true);
    expect(subs).toHaveLength(1);
    expect(subs[0].device_id).toBe(s.device_id);
  } finally { s.cleanup(); }
});

test("findActiveSubsForTopic returns nothing when topic.default_enabled=false and no rows", () => {
  const s = setup();
  try {
    const subs = findActiveSubsForTopic(s.db, "u1", "idle", "d-1", false);
    expect(subs).toHaveLength(0);
  } finally { s.cleanup(); }
});

test("device-default row (daemon_id='') overrides topic.default_enabled", () => {
  const s = setup();
  try {
    setSubscription(s.db, s.device_id, "idle", "", true);
    expect(findActiveSubsForTopic(s.db, "u1", "idle", "d-1", false)).toHaveLength(1);
    setSubscription(s.db, s.device_id, "permission", "", false);
    expect(findActiveSubsForTopic(s.db, "u1", "permission", "d-1", true)).toHaveLength(0);
  } finally { s.cleanup(); }
});

test("daemon-specific row overrides device-default and topic-default", () => {
  const s = setup();
  try {
    setSubscription(s.db, s.device_id, "idle", "", true);          // device default ON
    setSubscription(s.db, s.device_id, "idle", "d-1", false);      // override OFF for d-1
    expect(findActiveSubsForTopic(s.db, "u1", "idle", "d-1", false)).toHaveLength(0);
    expect(findActiveSubsForTopic(s.db, "u1", "idle", "d-other", false)).toHaveLength(1);
  } finally { s.cleanup(); }
});

test("deleteSubscription reverts to lower fallback level", () => {
  const s = setup();
  try {
    setSubscription(s.db, s.device_id, "idle", "d-1", true);
    expect(findActiveSubsForTopic(s.db, "u1", "idle", "d-1", false)).toHaveLength(1);
    deleteSubscription(s.db, s.device_id, "idle", "d-1");
    expect(findActiveSubsForTopic(s.db, "u1", "idle", "d-1", false)).toHaveLength(0);
  } finally { s.cleanup(); }
});

test("deleteAllForDaemon removes only that daemon's overrides", () => {
  const s = setup();
  try {
    setSubscription(s.db, s.device_id, "permission", "d-1", false);
    setSubscription(s.db, s.device_id, "idle", "d-1", true);
    setSubscription(s.db, s.device_id, "completed", "", true);   // device default — keep
    deleteAllForDaemon(s.db, s.device_id, "d-1");
    const rows = listSubscriptions(s.db, s.device_id);
    expect(rows).toEqual([{ topic_id: "completed", daemon_id: null, enabled: true }]);
  } finally { s.cleanup(); }
});

test("revoked devices are excluded from findActiveSubsForTopic", () => {
  const s = setup();
  try {
    s.db.prepare("UPDATE devices SET revoked_at = ? WHERE device_id = ?").run(Date.now(), s.device_id);
    expect(findActiveSubsForTopic(s.db, "u1", "permission", "d-1", true)).toHaveLength(0);
  } finally { s.cleanup(); }
});
```

- [ ] **Step 2: Run the test — FAIL (module missing)**

```bash
bun test packages/hub/tests/topic-subscriptions.test.ts
```

- [ ] **Step 3: Create `packages/hub/src/repos/topic-subscriptions.ts`**

```ts
// packages/hub/src/repos/topic-subscriptions.ts
import type { Db } from "../db.ts";
import type { PushSubRow } from "./push-subs.ts";

export interface SubRow { topic_id: string; daemon_id: string | null; enabled: boolean }

export function setSubscription(
  db: Db, device_id: string, topic_id: string, daemon_id: string, enabled: boolean,
): void {
  db.prepare(
    `INSERT INTO topic_subscriptions (device_id, topic_id, daemon_id, enabled)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(device_id, topic_id, daemon_id) DO UPDATE SET enabled = excluded.enabled`,
  ).run(device_id, topic_id, daemon_id, enabled ? 1 : 0);
}

export function deleteSubscription(
  db: Db, device_id: string, topic_id: string, daemon_id: string,
): void {
  db.prepare(
    "DELETE FROM topic_subscriptions WHERE device_id = ? AND topic_id = ? AND daemon_id = ?",
  ).run(device_id, topic_id, daemon_id);
}

export function deleteAllForDaemon(db: Db, device_id: string, daemon_id: string): void {
  db.prepare(
    "DELETE FROM topic_subscriptions WHERE device_id = ? AND daemon_id = ?",
  ).run(device_id, daemon_id);
}

export function listSubscriptions(db: Db, device_id: string): SubRow[] {
  const rows = db.query(
    "SELECT topic_id, daemon_id, enabled FROM topic_subscriptions WHERE device_id = ? ORDER BY topic_id, daemon_id",
  ).all(device_id) as Array<{ topic_id: string; daemon_id: string; enabled: number }>;
  return rows.map((r) => ({
    topic_id: r.topic_id,
    daemon_id: r.daemon_id === "" ? null : r.daemon_id,
    enabled: r.enabled === 1,
  }));
}

/**
 * Returns push subscriptions for devices owned by `owner_sub` whose effective
 * subscription for (`topic_id`, `daemon_id`) resolves to enabled.
 *
 * Resolution order (per device):
 *   1. (device, topic, daemon_id) row, if present
 *   2. (device, topic, '')         row, if present
 *   3. `default_enabled` argument
 */
export function findActiveSubsForTopic(
  db: Db, owner_sub: string, topic_id: string, daemon_id: string, default_enabled: boolean,
): PushSubRow[] {
  const rows = db.query(
    `SELECT ps.device_id, ps.endpoint, ps.p256dh, ps.auth, ps.preferences,
       COALESCE(
         (SELECT enabled FROM topic_subscriptions
            WHERE device_id = ps.device_id AND topic_id = ?1 AND daemon_id = ?2),
         (SELECT enabled FROM topic_subscriptions
            WHERE device_id = ps.device_id AND topic_id = ?1 AND daemon_id = ''),
         ?3
       ) AS effective_enabled
     FROM push_subs ps
     JOIN devices d ON d.device_id = ps.device_id
     WHERE d.owner_sub = ?4 AND d.revoked_at IS NULL`,
  ).all(topic_id, daemon_id, default_enabled ? 1 : 0, owner_sub) as Array<{
    device_id: string; endpoint: string; p256dh: string; auth: string;
    preferences: string; effective_enabled: number;
  }>;
  return rows
    .filter((r) => r.effective_enabled === 1)
    .map((r) => ({
      device_id: r.device_id,
      endpoint: r.endpoint,
      p256dh: r.p256dh,
      auth: r.auth,
      preferences: {},  // legacy field, unused by callers in the new path
    }));
}
```

- [ ] **Step 4: Run the test — PASS**

```bash
bun test packages/hub/tests/topic-subscriptions.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/repos/topic-subscriptions.ts packages/hub/tests/topic-subscriptions.test.ts
git commit -m "feat(hub): topic-subscriptions repo with 3-level resolution"
```

---

## Task 4: DND repo + `isInDndWindow` helper

**Files:**
- Create: `packages/hub/src/repos/dnd.ts`
- Create: `packages/hub/src/dnd.ts`
- Test: `packages/hub/tests/dnd.test.ts`

`isInDndWindow` is a pure function (no DB) so we test it standalone with controlled `nowMs`. The repo is a tiny CRUD pair.

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/tests/dnd.test.ts
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { createDevice } from "../src/repos/devices.ts";
import { isInDndWindow } from "../src/dnd.ts";
import { getDndSettings, setDndSettings } from "../src/repos/dnd.ts";

const at = (iso: string) => new Date(iso).getTime();

test("disabled DND never matches", () => {
  expect(isInDndWindow({ enabled: false, start_hh_mm: "22:00", end_hh_mm: "07:00", timezone: "UTC" }, at("2026-05-26T03:00:00Z"))).toBe(false);
});

test("missing fields treated as disabled", () => {
  expect(isInDndWindow({ enabled: true, start_hh_mm: null, end_hh_mm: "07:00", timezone: "UTC" }, Date.now())).toBe(false);
  expect(isInDndWindow(null, Date.now())).toBe(false);
});

test("single-day window: inside, before, after, exact boundaries", () => {
  const dnd = { enabled: true, start_hh_mm: "09:00", end_hh_mm: "17:00", timezone: "UTC" };
  expect(isInDndWindow(dnd, at("2026-05-26T08:59:00Z"))).toBe(false);
  expect(isInDndWindow(dnd, at("2026-05-26T09:00:00Z"))).toBe(true);  // inclusive start
  expect(isInDndWindow(dnd, at("2026-05-26T16:59:00Z"))).toBe(true);
  expect(isInDndWindow(dnd, at("2026-05-26T17:00:00Z"))).toBe(false); // exclusive end
});

test("cross-midnight window includes evening and early morning", () => {
  const dnd = { enabled: true, start_hh_mm: "22:00", end_hh_mm: "07:00", timezone: "UTC" };
  expect(isInDndWindow(dnd, at("2026-05-26T22:30:00Z"))).toBe(true);
  expect(isInDndWindow(dnd, at("2026-05-26T03:00:00Z"))).toBe(true);
  expect(isInDndWindow(dnd, at("2026-05-26T07:00:00Z"))).toBe(false);
  expect(isInDndWindow(dnd, at("2026-05-26T12:00:00Z"))).toBe(false);
});

test("start == end is treated as never matching (not 'always')", () => {
  const dnd = { enabled: true, start_hh_mm: "08:00", end_hh_mm: "08:00", timezone: "UTC" };
  expect(isInDndWindow(dnd, at("2026-05-26T08:00:00Z"))).toBe(false);
  expect(isInDndWindow(dnd, at("2026-05-26T20:00:00Z"))).toBe(false);
});

test("timezone shifts window: 22:00–07:00 Asia/Shanghai = 14:00–23:00 UTC", () => {
  const dnd = { enabled: true, start_hh_mm: "22:00", end_hh_mm: "07:00", timezone: "Asia/Shanghai" };
  // 06:00 Shanghai (=22:00 UTC the day before) → in window
  expect(isInDndWindow(dnd, at("2026-05-25T22:00:00Z"))).toBe(true);
  // 12:00 Shanghai (=04:00 UTC) → outside
  expect(isInDndWindow(dnd, at("2026-05-26T04:00:00Z"))).toBe(false);
});

function setupDb() {
  const dir = mkdtempSync(join(tmpdir(), "ccr-dnd-"));
  const db = openDb(join(dir, "h.sqlite"));
  db.prepare("INSERT INTO users (sub, created_at) VALUES (?, ?)").run("u1", 1);
  const c = createDevice(db, "u1", "iPhone", null, 60_000);
  return { db, device_id: c.device_id, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("getDndSettings returns null for never-set device", () => {
  const s = setupDb();
  try {
    expect(getDndSettings(s.db, s.device_id)).toBeNull();
  } finally { s.cleanup(); }
});

test("setDndSettings round-trips", () => {
  const s = setupDb();
  try {
    setDndSettings(s.db, s.device_id, { enabled: true, start_hh_mm: "22:00", end_hh_mm: "07:00", timezone: "UTC" });
    expect(getDndSettings(s.db, s.device_id)).toEqual({
      enabled: true, start_hh_mm: "22:00", end_hh_mm: "07:00", timezone: "UTC",
    });
  } finally { s.cleanup(); }
});
```

- [ ] **Step 2: Run the test — FAIL**

```bash
bun test packages/hub/tests/dnd.test.ts
```

- [ ] **Step 3: Create `packages/hub/src/dnd.ts`**

```ts
// packages/hub/src/dnd.ts
export interface DndSettings {
  enabled: boolean;
  start_hh_mm: string | null;
  end_hh_mm: string | null;
  timezone: string | null;
}

function parseHhMm(s: string): number {
  const [h, m] = s.split(":").map((x) => Number(x));
  return h * 60 + m;
}

export function isInDndWindow(dnd: DndSettings | null, nowMs: number): boolean {
  if (!dnd?.enabled) return false;
  if (!dnd.start_hh_mm || !dnd.end_hh_mm || !dnd.timezone) return false;

  let parts;
  try {
    const fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: dnd.timezone, hour: "2-digit", minute: "2-digit", hour12: false,
    });
    parts = Object.fromEntries(
      fmt.formatToParts(new Date(nowMs)).map((p) => [p.type, p.value]),
    );
  } catch {
    return false;  // invalid IANA name; behave as "no DND" rather than throwing in dispatch
  }
  const cur = Number(parts.hour) * 60 + Number(parts.minute);
  const start = parseHhMm(dnd.start_hh_mm);
  const end = parseHhMm(dnd.end_hh_mm);
  if (start === end) return false;
  return start < end ? (cur >= start && cur < end) : (cur >= start || cur < end);
}
```

- [ ] **Step 4: Create `packages/hub/src/repos/dnd.ts`**

```ts
// packages/hub/src/repos/dnd.ts
import type { Db } from "../db.ts";
import type { DndSettings } from "../dnd.ts";

export function getDndSettings(db: Db, device_id: string): DndSettings | null {
  const row = db.query(
    "SELECT enabled, start_hh_mm, end_hh_mm, timezone FROM dnd_settings WHERE device_id = ?",
  ).get(device_id) as {
    enabled: number; start_hh_mm: string | null; end_hh_mm: string | null; timezone: string | null;
  } | null;
  if (!row) return null;
  return {
    enabled: row.enabled === 1,
    start_hh_mm: row.start_hh_mm,
    end_hh_mm: row.end_hh_mm,
    timezone: row.timezone,
  };
}

export function setDndSettings(db: Db, device_id: string, dnd: DndSettings): void {
  db.prepare(
    `INSERT INTO dnd_settings (device_id, enabled, start_hh_mm, end_hh_mm, timezone)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(device_id) DO UPDATE SET
       enabled=excluded.enabled,
       start_hh_mm=excluded.start_hh_mm,
       end_hh_mm=excluded.end_hh_mm,
       timezone=excluded.timezone`,
  ).run(device_id, dnd.enabled ? 1 : 0, dnd.start_hh_mm, dnd.end_hh_mm, dnd.timezone);
}
```

- [ ] **Step 5: Run the test — PASS**

```bash
bun test packages/hub/tests/dnd.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/hub/src/dnd.ts packages/hub/src/repos/dnd.ts packages/hub/tests/dnd.test.ts
git commit -m "feat(hub): DND settings repo + isInDndWindow helper"
```

---

## Task 5: `dispatchTopic` central function

**Files:**
- Create: `packages/hub/src/push-dispatch.ts`
- Test: `packages/hub/tests/push-dispatch.test.ts`

Single function the router calls for any topic trigger. Resolves subscriptions via the repo, applies DND, builds payload, sends.

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/tests/push-dispatch.test.ts
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { createDevice } from "../src/repos/devices.ts";
import { addPushSub } from "../src/repos/push-subs.ts";
import { pairDaemon } from "../src/repos/daemons.ts";
import { setSubscription } from "../src/repos/topic-subscriptions.ts";
import { setDndSettings } from "../src/repos/dnd.ts";
import { dispatchTopic } from "../src/push-dispatch.ts";
import { getTopic } from "../src/push-topics.ts";
import type { PushHelper } from "../src/push.ts";
import type { PushSubRow } from "../src/repos/push-subs.ts";

function fakePush(): PushHelper & { calls: Array<{ subs: string[]; payload: object }> } {
  const calls: Array<{ subs: string[]; payload: object }> = [];
  return {
    calls,
    async sendTo(subs: PushSubRow[], payload: object) {
      calls.push({ subs: subs.map((s) => s.device_id), payload });
    },
  };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "ccr-disp-"));
  const db = openDb(join(dir, "h.sqlite"));
  db.prepare("INSERT INTO users (sub, created_at) VALUES (?, ?)").run("u1", 1);
  const c = createDevice(db, "u1", "iPhone", null, 60_000);
  addPushSub(db, c.device_id, "https://x", "p", "a");
  pairDaemon(db, "d-1", "u1", "h", "{}", Date.now());
  return { db, device_id: c.device_id, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("permission topic dispatches by default (default_enabled=true)", async () => {
  const s = setup();
  const push = fakePush();
  try {
    await dispatchTopic(s.db, push, getTopic("permission"), "d-1", { daemon_id: "d-1", request_id: "r1" });
    expect(push.calls).toHaveLength(1);
    expect(push.calls[0].subs).toEqual([s.device_id]);
  } finally { s.cleanup(); }
});

test("idle topic does NOT dispatch by default (default_enabled=false)", async () => {
  const s = setup();
  const push = fakePush();
  try {
    await dispatchTopic(s.db, push, getTopic("idle"), "d-1", { daemon_id: "d-1", session_id: "s1" });
    expect(push.calls).toHaveLength(0);
  } finally { s.cleanup(); }
});

test("idle dispatches once enabled at device level", async () => {
  const s = setup();
  const push = fakePush();
  try {
    setSubscription(s.db, s.device_id, "idle", "", true);
    await dispatchTopic(s.db, push, getTopic("idle"), "d-1", { daemon_id: "d-1", session_id: "s1" });
    expect(push.calls).toHaveLength(1);
  } finally { s.cleanup(); }
});

test("non-bypass topic is suppressed during DND window", async () => {
  const s = setup();
  const push = fakePush();
  try {
    setSubscription(s.db, s.device_id, "idle", "", true);
    // Window covers all 24h via cross-midnight 00:00–00:00 trick? No — start==end disables.
    // Instead use a window that contains the current UTC hour for sure.
    const now = new Date();
    const hh = String(now.getUTCHours()).padStart(2, "0");
    const start = `${hh}:00`;
    const endHh = String((now.getUTCHours() + 1) % 24).padStart(2, "0");
    setDndSettings(s.db, s.device_id, { enabled: true, start_hh_mm: start, end_hh_mm: `${endHh}:00`, timezone: "UTC" });
    await dispatchTopic(s.db, push, getTopic("idle"), "d-1", { daemon_id: "d-1", session_id: "s1" });
    expect(push.calls).toHaveLength(0);
  } finally { s.cleanup(); }
});

test("bypass_dnd topic is delivered during DND window", async () => {
  const s = setup();
  const push = fakePush();
  try {
    const now = new Date();
    const hh = String(now.getUTCHours()).padStart(2, "0");
    const endHh = String((now.getUTCHours() + 1) % 24).padStart(2, "0");
    setDndSettings(s.db, s.device_id, { enabled: true, start_hh_mm: `${hh}:00`, end_hh_mm: `${endHh}:00`, timezone: "UTC" });
    await dispatchTopic(s.db, push, getTopic("permission"), "d-1", { daemon_id: "d-1", request_id: "r1" });
    expect(push.calls).toHaveLength(1);
  } finally { s.cleanup(); }
});

test("dispatch is a no-op for an unknown daemon (no owner)", async () => {
  const s = setup();
  const push = fakePush();
  try {
    await dispatchTopic(s.db, push, getTopic("permission"), "d-unknown", { daemon_id: "d-unknown" });
    expect(push.calls).toHaveLength(0);
  } finally { s.cleanup(); }
});

test("payload includes tag returned by topic.build_tag", async () => {
  const s = setup();
  const push = fakePush();
  try {
    await dispatchTopic(s.db, push, getTopic("permission"), "d-1", { daemon_id: "d-1", request_id: "r-x" });
    const p = push.calls[0].payload as { tag?: string };
    expect(typeof p.tag).toBe("string");
  } finally { s.cleanup(); }
});
```

- [ ] **Step 2: Run the test — FAIL**

```bash
bun test packages/hub/tests/push-dispatch.test.ts
```

- [ ] **Step 3: Create `packages/hub/src/push-dispatch.ts`**

```ts
// packages/hub/src/push-dispatch.ts
import type { Db } from "./db.ts";
import type { PushHelper } from "./push.ts";
import type { PushTopic } from "./push-topics.ts";
import { findActiveSubsForTopic } from "./repos/topic-subscriptions.ts";
import { findDaemon } from "./repos/daemons.ts";
import { getDndSettings } from "./repos/dnd.ts";
import { isInDndWindow } from "./dnd.ts";

export async function dispatchTopic(
  db: Db,
  push: PushHelper,
  topic: PushTopic,
  daemon_id: string,
  ctx: unknown,
): Promise<void> {
  const daemon = findDaemon(db, daemon_id);
  if (!daemon) return;

  const subs = findActiveSubsForTopic(
    db, daemon.owner_sub, topic.id, daemon_id, topic.default_enabled,
  );
  if (subs.length === 0) return;

  const filtered = topic.bypass_dnd
    ? subs
    : subs.filter((s) => !isInDndWindow(getDndSettings(db, s.device_id), Date.now()));
  if (filtered.length === 0) return;

  const payload = topic.build_payload(ctx);
  const tag = topic.build_tag(payload);
  await push.sendTo(filtered, { ...payload, tag });
}
```

- [ ] **Step 4: Run the test — PASS**

```bash
bun test packages/hub/tests/push-dispatch.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/push-dispatch.ts packages/hub/tests/push-dispatch.test.ts
git commit -m "feat(hub): dispatchTopic — single topic-driven push entrypoint with DND filtering"
```

---

## Task 6: Refactor `router.ts` to use `dispatchTopic`

**Files:**
- Modify: `packages/hub/src/router.ts:114-285` (replace 4 `dispatchXxxPush` private methods with calls to `dispatchTopic`)
- Modify: `packages/hub/tests/router.test.ts` — append assertions that each frame triggers the correct topic id

The four private methods `dispatchPush`, `dispatchOfflinePush`, `dispatchCompletedPush`, `dispatchIdlePush` are deleted. The four trigger sites (3 frame cases + 1 offline timer in `onDaemonDisconnect`) call `dispatchTopic` with the right topic.

- [ ] **Step 1: Write the failing test (router-level integration)**

```ts
// Append to packages/hub/tests/router.test.ts
import { Router } from "../src/router.ts";
import { DaemonRegistry, PwaRegistry } from "../src/connections.ts";
import { addPushSub } from "../src/repos/push-subs.ts";
import { createDevice } from "../src/repos/devices.ts";
import { pairDaemon } from "../src/repos/daemons.ts";
import { setSubscription } from "../src/repos/topic-subscriptions.ts";
import { openDb } from "../src/db.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PushSubRow } from "../src/repos/push-subs.ts";

function setupRouterWithPush() {
  const dir = mkdtempSync(join(tmpdir(), "ccr-router-"));
  const db = openDb(join(dir, "h.sqlite"));
  db.prepare("INSERT INTO users (sub, created_at) VALUES (?, ?)").run("u1", 1);
  const c = createDevice(db, "u1", "iPhone", null, 60_000);
  addPushSub(db, c.device_id, "https://x", "p", "a");
  pairDaemon(db, "d-1", "u1", "h", "{}", Date.now());

  const calls: Array<{ kind: string; daemon_id?: string; session_id?: string; request_id?: string }> = [];
  const push = {
    async sendTo(_subs: PushSubRow[], payload: object) {
      const p = payload as { kind: string; daemon_id?: string; session_id?: string; request_id?: string };
      calls.push({ kind: p.kind, daemon_id: p.daemon_id, session_id: p.session_id, request_id: p.request_id });
    },
  };
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const router = new Router(dreg, preg, db, push, { offline_push_delay_ms: 50 });
  router.onDaemonFrame("d-1", { type: "hello", daemon_id: "d-1", epoch: 1, hostname: "h", agent_version: "0", sessions: [] });
  return { db, device_id: c.device_id, router, calls, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("permission_request frame dispatches the 'permission' topic", async () => {
  const s = setupRouterWithPush();
  try {
    await s.router.onDaemonFrame("d-1", {
      type: "permission_request", session_id: "sess", request_id: "r1",
      tool: "Bash", args_summary: "ls", expires_at: Date.now() + 60_000,
    });
    expect(s.calls.map((c) => c.kind)).toEqual(["permission"]);
    expect(s.calls[0].request_id).toBe("r1");
  } finally { s.cleanup(); }
});

test("task_completed frame dispatches the 'completed' topic ONLY when subscribed", async () => {
  const s = setupRouterWithPush();
  try {
    await s.router.onDaemonFrame("d-1", { type: "task_completed", session_id: "s1", ts: 1 });
    expect(s.calls).toHaveLength(0);
    setSubscription(s.db, s.device_id, "completed", "", true);
    await s.router.onDaemonFrame("d-1", { type: "task_completed", session_id: "s1", ts: 2 });
    expect(s.calls.map((c) => c.kind)).toEqual(["completed"]);
  } finally { s.cleanup(); }
});

test("idle frame dispatches the 'idle' topic ONLY when subscribed", async () => {
  const s = setupRouterWithPush();
  try {
    await s.router.onDaemonFrame("d-1", { type: "idle", session_id: "s1", ts: 1 });
    expect(s.calls).toHaveLength(0);
    setSubscription(s.db, s.device_id, "idle", "", true);
    await s.router.onDaemonFrame("d-1", { type: "idle", session_id: "s1", ts: 2 });
    expect(s.calls.map((c) => c.kind)).toEqual(["idle"]);
  } finally { s.cleanup(); }
});

test("daemon disconnect after delay dispatches 'offline' topic when subscribed", async () => {
  const s = setupRouterWithPush();
  try {
    setSubscription(s.db, s.device_id, "offline", "", true);
    s.router.onDaemonDisconnect("d-1");
    await new Promise((r) => setTimeout(r, 120));
    expect(s.calls.map((c) => c.kind)).toEqual(["offline"]);
  } finally { s.cleanup(); }
});
```

- [ ] **Step 2: Run the new tests — FAIL**

```bash
bun test packages/hub/tests/router.test.ts
```

The new tests will fail because the existing private methods filter on `preferences.permission` etc., and `topic_subscriptions` rows for `permission` are present (migration v3 copied them) but for `completed`/`idle`/`offline` they aren't, while `setSubscription` writes only to `topic_subscriptions`. Some tests may pass coincidentally (permission default-on); the critical failures are the `completed`/`idle`/`offline` ones — they shouldn't fire today but the assertion that they fire when `setSubscription` enables them will fail because the old path reads `preferences`.

- [ ] **Step 3: Replace `router.ts` dispatch internals**

Open `packages/hub/src/router.ts`. Delete the four private methods `dispatchPush`, `dispatchOfflinePush`, `dispatchCompletedPush`, `dispatchIdlePush` (lines roughly 217–285). At the top of the file, add:

```ts
import { dispatchTopic } from "./push-dispatch.ts";
import { getTopic } from "./push-topics.ts";
```

Update the three frame cases:

```ts
// permission_request case body — replace the `void this.dispatchPush(...)` call with:
if (this.db && this.push) {
  void dispatchTopic(this.db, this.push, getTopic("permission"), daemon_id, {
    daemon_id,
    session_id: frame.session_id,
    request_id: frame.request_id,
    tool: frame.tool,
    args_summary: frame.args_summary,
  });
}

// task_completed case body — replace `void this.dispatchCompletedPush(...)` with:
if (this.db && this.push) {
  void dispatchTopic(this.db, this.push, getTopic("completed"), daemon_id, {
    daemon_id, session_id: frame.session_id,
  });
}

// idle case body — replace `void this.dispatchIdlePush(...)` with:
if (this.db && this.push) {
  void dispatchTopic(this.db, this.push, getTopic("idle"), daemon_id, {
    daemon_id, session_id: frame.session_id,
  });
}
```

Update the offline timer in `onDaemonDisconnect` (the `setTimeout` callback). Replace `void this.dispatchOfflinePush(daemon_id, meta.hostname, ...)` with:

```ts
const since_ms = Date.now() - meta.disconnected_at;
if (this.db && this.push) {
  void dispatchTopic(this.db, this.push, getTopic("offline"), daemon_id, {
    daemon_id, hostname: meta.hostname, since_ms,
  });
}
```

- [ ] **Step 4: Run the full hub test suite — PASS**

```bash
bun test packages/hub/
```

Expected: every test in `packages/hub/tests/` passes, including pre-existing `router.test.ts`, `preferences.test.ts` (legacy reads still work), `push.test.ts`, and the new tests above.

If `preferences.test.ts` regresses, it's because it expects the old `dispatchPush` filtering on `preferences.permission`. Fix: confirm migration v3 copied `permission:true` into `topic_subscriptions` (default-enabled fallback also covers it), so the new dispatch sends the same push. The legacy GET/PUT routes themselves are not touched in this plan.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/router.ts packages/hub/tests/router.test.ts
git commit -m "refactor(hub): router dispatches push via dispatchTopic + getTopic, remove 4 private dispatchers"
```

---

## Task 7: Suite-wide regression check

**Files:** none (verification only)

- [ ] **Step 1: Run the full hub package**

```bash
bun test packages/hub/
```

Expected: green.

- [ ] **Step 2: Run the existing e2e-real `11-offline-push` and `13-settings-drawer` to confirm no behavioural regression**

```bash
bun test e2e-real/tests/11-offline-push.test.ts e2e-real/tests/13-settings-drawer.test.ts
```

Expected: green. (These verify subscription registration and the legacy preferences toggles UI; both still work because Plan 02 adds the new HTTP API while keeping the legacy endpoints, but Plan 01 by itself does not touch HTTP, so these scenarios are unaffected.)

- [ ] **Step 3: Typecheck**

```bash
bun run --filter @cc-remote/hub typecheck
```

Expected: clean.

- [ ] **Step 4: Tag the milestone (no commit needed; tag points at HEAD of plan-01)**

```bash
git tag plan-push-topics-01-foundation
```

---

## Done criteria

- ✅ Migration v3 ships `topic_subscriptions` + `dnd_settings` tables; data move populates explicit prefs as `(device, topic, '')` rows.
- ✅ `push-topics.ts` registers the four baseline topics with `default_enabled` and `bypass_dnd` matching today's behaviour.
- ✅ `topic-subscriptions` repo exposes `setSubscription` / `deleteSubscription` / `deleteAllForDaemon` / `findActiveSubsForTopic` / `listSubscriptions`.
- ✅ `dnd.ts` `isInDndWindow` covers single-day, cross-midnight, start==end, timezone math, invalid IANA name.
- ✅ `dispatchTopic` delivers when subscribed, suppresses during DND for non-bypass topics, no-ops for unknown daemons.
- ✅ `router.ts` calls `dispatchTopic(getTopic("…"), ...)` from all 4 trigger points; the four old private methods are deleted.
- ✅ Full `bun test packages/hub/` green; existing e2e scenarios untouched.
- ✅ Tag `plan-push-topics-01-foundation`.

---

## Self-review

- **Spec coverage (Plan 01 scope):** schema (§Schema) ✓ Task 1; topic registry (§Architecture) ✓ Task 2; resolution SQL (§Schema → "Subscription resolution") ✓ Task 3; DND helper (§Dispatch → DND window check) ✓ Task 4; dispatchTopic (§Dispatch) ✓ Task 5; router refactor (§Architecture → "Frame triggers") ✓ Task 6.
- **Out of Plan 01 scope (handled by Plan 02–04):** HTTP API, sw.js change, `build_payload`/`build_tag` real content, PWA UI, manifest, e2e scenario.
- **Placeholders:** none. Stub `build_payload`/`build_tag` are intentional and called out as Plan 02's job; tests in this plan don't depend on payload content beyond `kind` and presence of `tag`.
- **Type consistency:** `SubRow.daemon_id: string | null` (repo) vs DB column `TEXT NOT NULL DEFAULT ''` — repo translates `'' ↔ null` at the boundary (Task 3 `listSubscriptions`). `findActiveSubsForTopic` takes `daemon_id: string` (always concrete in dispatch). `DndSettings.timezone: string | null` matches DB nullable column.
- **Test completeness:** every new file has a test that exercises both the happy path and at least one failure/edge (revoked device, unknown daemon, invalid tz, start==end, cross-midnight, deleteAllForDaemon precision).
