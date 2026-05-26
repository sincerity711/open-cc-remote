# Push Topics — Plan 04: PWA Deployment + e2e Scenario

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make push notifications usable in production on Android Chrome and iOS 16.4+ installed PWAs (manifest + icons + ops docs), then add an e2e-real scenario that proves per-daemon mute and DND are honoured against the running hub container with the fake-VAPID push trace.

**Architecture:** Add `manifest.webmanifest` + apple-touch-icon + theme/manifest meta tags. Generate three PNG icons from one SVG via a build-time script. Author `docs/operations/push-deployment.md`. New e2e scenario `21-push-topics.test.ts` reads `/data/push-trace.log` from the hub container after triggering frames, asserting on `kind`, `tag`, and presence/absence per subscription state.

**Tech Stack:** Vite (PWA), `web-push` (already a dep), Playwright + docker-compose for e2e. Icon generation via `sharp` (zero-config CLI).

**Spec reference:** `docs/superpowers/specs/2026-05-25-push-topics-design.md`

**Depends on:** Plans 01–03.

---

## File map

| Path | What |
|---|---|
| `packages/pwa/public/manifest.webmanifest` | **new** |
| `packages/pwa/public/icon.svg` | **new** — single SVG source |
| `packages/pwa/public/icon-192.png` | **new** generated |
| `packages/pwa/public/icon-512.png` | **new** generated |
| `packages/pwa/public/icon-512-maskable.png` | **new** generated |
| `packages/pwa/scripts/build-icons.mjs` | **new** — sharp-based one-shot |
| `packages/pwa/index.html` | add manifest link, apple-touch-icon, theme-color, apple-mobile-web-app-capable |
| `docs/operations/push-deployment.md` | **new** |
| `e2e-real/tests/21-push-topics.test.ts` | **new** scenario covering per-daemon mute + DND + tag dedup |
| `e2e-real/helpers/push-trace.ts` | **new** — read+parse `/data/push-trace.log` from hub container |

---

## Task 1: SVG icon source + sharp script + PNGs

**Files:**
- Create: `packages/pwa/public/icon.svg`
- Create: `packages/pwa/scripts/build-icons.mjs`
- Generate (and commit): `packages/pwa/public/icon-192.png`, `icon-512.png`, `icon-512-maskable.png`

We commit the PNGs so production builds don't require running the script. The script is for regeneration when the SVG changes.

- [ ] **Step 1: Create the SVG source**

```svg
<!-- packages/pwa/public/icon.svg -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#000000"/>
  <text x="256" y="320" font-family="ui-monospace, SFMono-Regular, Menlo, monospace"
        font-size="220" font-weight="700" fill="#ffffff" text-anchor="middle">cc</text>
</svg>
```

(Plain placeholder — design iteration is out of scope for this plan; this satisfies manifest + iOS install requirements.)

- [ ] **Step 2: Add `sharp` as a dev dependency in `packages/pwa`**

```bash
bun add -d sharp --cwd packages/pwa
```

- [ ] **Step 3: Create `packages/pwa/scripts/build-icons.mjs`**

```js
// packages/pwa/scripts/build-icons.mjs
// Regenerate PNG icons from public/icon.svg. Run manually when icon.svg changes:
//   bun run --filter @cc-remote/pwa icons
import sharp from "sharp";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pub = resolve(here, "..", "public");
const svg = readFileSync(resolve(pub, "icon.svg"));

await Promise.all([
  sharp(svg).resize(192, 192).png().toFile(resolve(pub, "icon-192.png")),
  sharp(svg).resize(512, 512).png().toFile(resolve(pub, "icon-512.png")),
  // Maskable: pad the safe zone (10% on each side).
  sharp(svg).resize(410, 410).extend({
    top: 51, bottom: 51, left: 51, right: 51,
    background: { r: 0, g: 0, b: 0, alpha: 1 },
  }).png().toFile(resolve(pub, "icon-512-maskable.png")),
]);
console.log("icons regenerated");
```

- [ ] **Step 4: Add `icons` script to `packages/pwa/package.json`**

```json
{
  "scripts": {
    "icons": "bun run scripts/build-icons.mjs"
  }
}
```

- [ ] **Step 5: Run the script**

```bash
bun run --filter @cc-remote/pwa icons
```

Expected: prints "icons regenerated"; three PNGs appear in `packages/pwa/public/`.

- [ ] **Step 6: Commit**

```bash
git add packages/pwa/public/icon.svg packages/pwa/public/icon-192.png packages/pwa/public/icon-512.png packages/pwa/public/icon-512-maskable.png packages/pwa/scripts/build-icons.mjs packages/pwa/package.json bun.lock
git commit -m "feat(pwa): icon source SVG + generated PNGs + sharp script"
```

---

## Task 2: Manifest + index.html meta

**Files:**
- Create: `packages/pwa/public/manifest.webmanifest`
- Modify: `packages/pwa/index.html`

- [ ] **Step 1: Create the manifest**

```json
{
  "name": "cc-remote",
  "short_name": "cc-remote",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#000000",
  "icons": [
    { "src": "/icon-192.png",          "sizes": "192x192", "type": "image/png" },
    { "src": "/icon-512.png",          "sizes": "512x512", "type": "image/png" },
    { "src": "/icon-512-maskable.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

- [ ] **Step 2: Add meta tags to `packages/pwa/index.html`**

Replace the `<head>` with:

```html
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="manifest" href="/manifest.webmanifest" />
  <link rel="apple-touch-icon" href="/icon-192.png" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="theme-color" content="#000000" />
  <title>cc-remote</title>
</head>
```

- [ ] **Step 3: Build and confirm assets are emitted**

```bash
bun run --filter @cc-remote/pwa build
ls packages/pwa/dist/manifest.webmanifest packages/pwa/dist/icon-512.png
```

Expected: both files exist in `dist/`.

- [ ] **Step 4: Commit**

```bash
git add packages/pwa/public/manifest.webmanifest packages/pwa/index.html
git commit -m "feat(pwa): manifest + apple-touch-icon + theme/standalone meta for installable PWA"
```

---

## Task 3: Operations documentation

**Files:**
- Create: `docs/operations/push-deployment.md`

- [ ] **Step 1: Write the doc**

```markdown
# Push deployment

The hub uses Web Push (VAPID). On Android Chrome and on iOS 16.4+ when the PWA
is installed to the home screen, browsers honour Web Push by bridging to FCM
or APNs respectively — the hub does not need a native SDK.

## Generate VAPID keys

```
npx web-push generate-vapid-keys
```

Output is two base64url strings (public + private). Treat the private key as a secret.

## Configure the hub

Set three environment variables on the hub container/process:

```
HUB_VAPID_PUBLIC_KEY=<public_key>
HUB_VAPID_PRIVATE_KEY=<private_key>
HUB_VAPID_SUBJECT=mailto:ops@your-domain.example
```

If any one is missing the hub logs a warning and Web Push is disabled.

## Configure the PWA build

The PWA reads the public key at build time:

```
VITE_VAPID_PUBLIC_KEY=<public_key>
```

If the variable is unset, `registerPushSubscription` returns
`{ registered: false, reason: "VITE_VAPID_PUBLIC_KEY not configured" }` and
the PWA shows a notice; nothing else is affected.

## TLS and origin

Web Push is served over HTTPS only (browser hard requirement). The PWA must
be served from the same HTTPS origin used during sign-in and WebSocket
connection, or you will hit secure-cookie / CORS issues. Localhost is exempt
during development.

## iOS installed-PWA caveat

iOS only delivers Web Push to PWAs that the user has explicitly added to the
home screen and launched from that icon. Visiting the site in Safari does
not subscribe. The PWA detects this case and shows a one-time hint.

## Verification

After deploying:

1. Open the PWA on a real Android Chrome device (or iOS 16.4+, **installed**).
2. Sign in, open Settings, allow notifications when prompted.
3. From a daemon: trigger a permission request — the device should show the
   notification immediately.
4. Disconnect the daemon and wait ~30s — `offline` notification should arrive
   if subscribed.
5. On the hub, tail logs for `web-push send to … failed:` lines; 410/404
   responses indicate stale subscriptions and are expected over time.
```

- [ ] **Step 2: Commit**

```bash
git add docs/operations/push-deployment.md
git commit -m "docs: VAPID + manifest + iOS install caveat operational guide"
```

---

## Task 4: e2e push-trace helper

**Files:**
- Create: `e2e-real/helpers/push-trace.ts`

Reads `/data/push-trace.log` from the hub container via `docker compose exec`. Parses NDJSON lines into a typed shape.

- [ ] **Step 1: Write the failing test inline (use a stub)**

Skip a dedicated unit test — this helper is exercised by scenario 21 directly.

- [ ] **Step 2: Create the helper**

```ts
// e2e-real/helpers/push-trace.ts
import { spawn } from "node:child_process";

export interface PushTraceEntry {
  ts: number;
  subs: string[];
  payload: { kind: string; tag: string; daemon_id?: string; session_id?: string; request_id?: string; body?: string; [k: string]: unknown };
}

async function exec(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let out = "", err = "";
    p.stdout.on("data", (b) => { out += String(b); });
    p.stderr.on("data", (b) => { err += String(b); });
    p.on("close", (code) => code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.join(" ")} → ${code}\n${err}`)));
  });
}

export async function readPushTrace(): Promise<PushTraceEntry[]> {
  // The hub container in e2e-real/docker-compose.yml writes to /data/push-trace.log.
  // `docker compose exec` runs against the project compose file; default cwd is e2e-real/.
  let raw: string;
  try {
    raw = await exec("docker", ["compose", "exec", "-T", "hub", "sh", "-c", "cat /data/push-trace.log 2>/dev/null || true"]);
  } catch (e) {
    return [];
  }
  return raw.split("\n").filter((l) => l.trim().length > 0).map((line) => JSON.parse(line) as PushTraceEntry);
}

export async function clearPushTrace(): Promise<void> {
  try {
    await exec("docker", ["compose", "exec", "-T", "hub", "sh", "-c", ": > /data/push-trace.log"]);
  } catch {
    /* ignore — first run before file exists */
  }
}

export async function waitForPushKind(kind: string, timeoutMs = 5_000): Promise<PushTraceEntry | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entries = await readPushTrace();
    const hit = entries.find((e) => e.payload.kind === kind);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}
```

- [ ] **Step 3: Commit**

```bash
git add e2e-real/helpers/push-trace.ts
git commit -m "feat(e2e): push-trace helper reads /data/push-trace.log via docker compose exec"
```

---

## Task 5: e2e scenario 21 — per-daemon mute + DND + tag dedup

**Files:**
- Create: `e2e-real/tests/21-push-topics.test.ts`

The scenario runs the existing single-daemon compose (no second daemon is needed: the per-daemon override case is exercised by toggling override OFF for `daemon_a` then asserting the trigger produced no entry; daemon-not-overridden is implicitly the default fallback). DND is exercised by setting a window covering "now" and triggering a non-bypass topic.

The scenario uses bearer-based fetches against the hub HTTP API (per Plan 02 routes); no Playwright browser is required.

- [ ] **Step 1: Author the scenario**

```ts
// e2e-real/tests/21-push-topics.test.ts
import { test, expect } from "@playwright/test";
import { upCompose, downCompose } from "../helpers/compose.ts";
import { pairAndStartDaemon, makeScenarioContext } from "../helpers/scenario.ts";
import { loginAndConnect } from "../helpers/pwa-client.ts";
import { readPushTrace, clearPushTrace, waitForPushKind } from "../helpers/push-trace.ts";
import { syncIfPassed } from "../helpers/sync-screenshots.ts";

const HUB_HTTP = "http://localhost:7745";
const HUB_WS   = "ws://localhost:7745";

test.beforeAll(async () => { await upCompose(); });
test.afterAll(async () => { await downCompose(); });
test.afterEach(async ({}, testInfo) => { await syncIfPassed(testInfo, "21-push-topics"); });

async function api(bearer: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${HUB_HTTP}${path}`, {
    ...init,
    headers: { ...init.headers, authorization: `Bearer ${bearer}` },
  });
  if (!res.ok && res.status !== 204) throw new Error(`${init.method ?? "GET"} ${path} → ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : await res.json();
}

test("push topics: per-daemon mute + DND + tag dedup", async ({ }, testInfo) => {
  test.setTimeout(120_000);

  const ctx = makeScenarioContext("21-push-topics");
  const daemon_id = `pt-${Date.now()}`;
  const handle = await pairAndStartDaemon({ daemon_id, hub_url: HUB_WS, hub_http: HUB_HTTP });

  // Connect "PWA" to receive bearer + register a push subscription.
  const pwa = await loginAndConnect({ hub_http: HUB_HTTP, hub_ws: HUB_WS, ctx });
  // Register a fake push subscription so dispatchTopic has a target.
  await fetch(`${HUB_HTTP}/push/subscribe`, {
    method: "POST",
    headers: { authorization: `Bearer ${pwa.bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ endpoint: `https://fake/${daemon_id}`, keys: { p256dh: "p", auth: "a" } }),
  });

  // ── A. Default state: idle is OFF → triggering idle yields no push entry.
  await clearPushTrace();
  await handle.emitFrame({ type: "idle", session_id: "s-1", ts: Math.floor(Date.now() / 1000) });
  await new Promise((r) => setTimeout(r, 800));
  expect(await readPushTrace()).toHaveLength(0);

  // ── B. Enable idle at the device default → idle dispatches.
  await api(pwa.bearer, "/push/topics/subscriptions", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ topic_id: "idle", daemon_id: null, enabled: true }),
  });
  await clearPushTrace();
  await handle.emitFrame({ type: "idle", session_id: "s-1", ts: Math.floor(Date.now() / 1000) });
  const idleEntry = await waitForPushKind("idle", 3000);
  expect(idleEntry).not.toBeNull();
  expect(idleEntry!.payload.tag).toBe(`idle:${daemon_id}:s-1`);

  // ── C. Per-daemon override: idle=false for our daemon → idle dispatch suppressed.
  await api(pwa.bearer, "/push/topics/subscriptions", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ topic_id: "idle", daemon_id, enabled: false }),
  });
  await clearPushTrace();
  await handle.emitFrame({ type: "idle", session_id: "s-1", ts: Math.floor(Date.now() / 1000) });
  await new Promise((r) => setTimeout(r, 800));
  expect((await readPushTrace()).filter((e) => e.payload.kind === "idle")).toHaveLength(0);

  // ── D. DND covering "now" suppresses non-bypass (idle), permits bypass (permission).
  // Remove the per-daemon override so idle would otherwise fire.
  await api(pwa.bearer, "/push/topics/subscriptions", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ topic_id: "idle", daemon_id }),
  });
  const now = new Date();
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const endHh = String((now.getUTCHours() + 1) % 24).padStart(2, "0");
  await api(pwa.bearer, "/push/dnd", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true, start_hh_mm: `${hh}:00`, end_hh_mm: `${endHh}:00`, timezone: "UTC" }),
  });

  await clearPushTrace();
  await handle.emitFrame({ type: "idle", session_id: "s-2", ts: Math.floor(Date.now() / 1000) });
  await new Promise((r) => setTimeout(r, 800));
  expect((await readPushTrace()).filter((e) => e.payload.kind === "idle")).toHaveLength(0);

  await clearPushTrace();
  await handle.emitFrame({
    type: "permission_request",
    session_id: "s-2",
    request_id: "rq-during-dnd",
    tool: "Bash",
    args_summary: "ls",
    expires_at: Date.now() + 60_000,
  });
  const permEntry = await waitForPushKind("permission", 3000);
  expect(permEntry).not.toBeNull();
  expect(permEntry!.payload.tag).toBe("permission:rq-during-dnd");
});
```

> **Note on `handle.emitFrame`:** the existing `pairAndStartDaemon` helper returns a daemon handle that runs a real daemon process. If the helper does not expose a frame-emit shortcut, use the existing `replay-jsonl.ts` mechanism (or trigger the frames via the same path scenario 5 / 11 use — i.e., a real Claude turn or the hub's admin endpoints). Read `e2e-real/helpers/scenario.ts` first; if no such method exists, replace `handle.emitFrame(...)` with the equivalent helper used by scenarios 5 (`task_completed`) and 2 (`permission_request`). The scenario MUST drive frames through the real daemon path — direct DB writes are not acceptable.

- [ ] **Step 2: Run the scenario**

```bash
bun test e2e-real/tests/21-push-topics.test.ts
```

Expected: green within ~60s.

- [ ] **Step 3: Run the full e2e suite to confirm no regression**

```bash
bun test e2e-real/
```

Expected: all green; spec §8 budget (< 6 min) still holds.

- [ ] **Step 4: Commit**

```bash
git add e2e-real/tests/21-push-topics.test.ts
git commit -m "test(e2e): scenario 21 — per-daemon mute + DND + tag dedup against real hub"
```

---

## Task 6: TODO + memory updates + final tag

**Files:**
- Modify: `docs/TODO.md`
- Modify: `~/.claude/projects/-Users-i060912-SAPDevelop-channel/memory/MEMORY.md` (add a progress entry pointer)

- [ ] **Step 1: Update `docs/TODO.md`**

Strike-through the "Channel-based notifications" entry under "Settings page gaps" and the "Real push notification chain" backlog item. Add a new completed-plans block:

```markdown
## Plan completed (2026-05-26)

- `docs/superpowers/plans/2026-05-26-push-topics-plan-01-hub-foundation.md` — DONE — tagged `plan-push-topics-01-foundation`.
- `docs/superpowers/plans/2026-05-26-push-topics-plan-02-hub-api.md` — DONE — tagged `plan-push-topics-02-api`.
- `docs/superpowers/plans/2026-05-26-push-topics-plan-03-pwa-ui.md` — DONE — tagged `plan-push-topics-03-pwa`.
- `docs/superpowers/plans/2026-05-26-push-topics-plan-04-pwa-deploy-and-e2e.md` — DONE — tagged `plan-push-topics-04-deploy`.
```

- [ ] **Step 2: Add memory entry for project progress**

Create a memory file `~/.claude/projects/-Users-i060912-SAPDevelop-channel/memory/project_progress_20260526.md` with a one-line MEMORY.md pointer. (Per the auto-memory rules: keep MEMORY.md to a one-line entry; the body of the memory points at the plans + tags.)

- [ ] **Step 3: Final tag**

```bash
git tag plan-push-topics-04-deploy
```

- [ ] **Step 4: Commit**

```bash
git add docs/TODO.md
git commit -m "docs: mark push topics plans done, refresh backlog"
```

---

## Done criteria

- ✅ `manifest.webmanifest` + apple-touch-icon + theme/standalone meta in PWA build output.
- ✅ Three icons committed; regen script available.
- ✅ `docs/operations/push-deployment.md` covers VAPID gen, env vars, TLS, iOS install caveat, verification steps.
- ✅ `e2e-real/tests/21-push-topics.test.ts` green: per-daemon mute, DND non-bypass suppression, DND bypass for permission, tag values match spec.
- ✅ `docs/TODO.md` updated; tags `plan-push-topics-01..04` exist.

---

## Self-review

- **Spec coverage (Plan 04 scope):** §PWA manifest ✓ Tasks 1/2; §Production VAPID deployment ✓ Task 3; §Testing → e2e-real ✓ Task 5.
- **Out of any plan in this series:** removal of legacy `/push/preferences` shim and removal of `push_subs.preferences` column — both are scheduled for the release **after** this one (per spec Migration & rollback section).
- **Placeholders:** none. The scenario 21 note about `handle.emitFrame` is an implementor instruction (read the existing helpers, use the existing pattern), not a placeholder for code we expect them to invent.
- **Test completeness:** scenario covers 4 distinct assertions (default-off, enable, per-daemon override, DND with bypass). Each step uses `clearPushTrace` for isolation.
- **Risk surface flagged:** the scenario relies on the existing fake-VAPID `HUB_PUSH_TRACE_PATH` plumbing. If a future cleanup removes `fileLogHelper`, this scenario breaks visibly — that's intentional, the file-log helper is the contract.
