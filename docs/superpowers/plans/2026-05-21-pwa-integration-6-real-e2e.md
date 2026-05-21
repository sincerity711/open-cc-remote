# PWA Integration P6 — Real E2E (Playwright) Conversion Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After P1–P5 finish, every UI flow the prototype-integration introduced must be exercised by **real-browser e2e tests** — not protocol-only scripted clients. Convert `e2e-real/` from `helpers/pwa-client.ts` (WS-only) to browser-driven Playwright per spec §4.5, add the manual-smoke flows that P3/P4/P5 deferred (those steps were skipped during subagent dispatch), and produce screenshot baselines for visual regression.

**Architecture:** Keep the in-process `bun test e2e/` suite (fake-claude, ~20s) as the fast merge gate — unchanged. Rewrite `e2e-real/` scenarios to drive the live PWA in a real browser via Playwright; reuse the existing docker-compose hub, fake-IAS, real-claude-under-tmux infrastructure. The PWA is served via `vite preview` on a port the browser hits. Each `scenario.step(label, ...)` auto-captures a PNG; successful runs sync into `e2e-real/screenshots/<scenario>/` (tracked) while raw artifacts go to `e2e-real/artifacts/<run-id>/` (gitignored). v1 visual regression policy is **human review of `git diff e2e-real/screenshots/`** — no pixel-diff tooling, no baseline lock.

**Tech Stack:** Playwright (new dep, ~80MB browser), Bun runtime, `vite preview` for the PWA, the existing docker-compose / tmux / claude infrastructure. No changes to hub / daemon / plugin source.

**Reference:** Spec — `docs/superpowers/specs/2026-05-21-pwa-prototype-integration-design.md` §4.5 (e2e-real visual capture overhaul, V1–V4 phasing) and §4.1 (test strategy / stable-selector list). Existing infra — `e2e-real/README.md`, `e2e-real/helpers/pwa-client.ts` (kept for protocol-only scenarios like `10-perm-p95.test.ts`).

**Prerequisite:** P1–P5 complete and tagged `plan-pwa-prototype-integration`. The new screens already have stable `data-testid`s installed by P3/P4/P5: `app-shell-header`, `home-screen`, `permission-mini`, `machine-card-${daemon_id}`, `sessions-${daemon_id}`, `session-view`, `chat-input`, `chat-log`, `timeline`, `permission-surface`, `permission-queue`, `settings-drawer`, `sign-in-screen`. See spec §4.1 for the binding contract.

---

## Why this is its own plan, not glued onto P5

P5 ships the production code. This plan ships test infrastructure. They evolve on different cadences — Playwright will change per Claude Code releases, viewport renderings will drift across OS updates — and the diffs are heavy (image bytes). Keeping them separate keeps the P5 history readable.

## What converts vs. what stays

| Suite | Today | After P6 |
|---|---|---|
| `bun test packages/` | unit + static-markup smokes | unchanged |
| `bun test e2e/` (in-process, fake-claude, 17 tests / 12 files) | merge gate, ~20s | unchanged — still the merge gate |
| `bun test e2e-real/` (12 scenarios, WS-only via `pwa-client.ts`, ~5.4 min) | acceptance | **converted to Playwright browser-driven**; `pwa-client.ts` retained for `10-perm-p95.test.ts` only |
| Manual smokes from P3/P4/P5 (skipped during dispatch) | none | **covered by new Playwright scenarios** |

The 11 non-perf scenarios become Playwright. `10-perm-p95.test.ts` keeps `pwa-client.ts` because the browser would add p95 noise — protocol latency is the metric.

## Manual-smoke debt to retire

Each plan dispatched subagents that explicitly skipped the manual `bun run dev` smoke (per my instructions). Listed here so each maps to a Playwright test in this plan:

| Smoke (skipped during) | Coverage in this plan |
|---|---|
| P3 Task 7 Step 4 — chat round-trip + permission flow on `/` | Task 5: scenario `02-permission-relay` |
| P4 Task 5 Step 4 — three-breakpoint home/session layout | Task 11: multi-viewport wrapper covers `01` / `02` / `12` |
| P4 Task 8 Step 5 — three-form permission surface (sheet/modal/aside) + multi-pending advance + already-handled toast | Task 6: scenario `multi-pending` (new) and `02-permission-relay` |
| P5 Task 3 Step 3 — Settings drawer end-to-end (rename / revoke / push-pref toggle / appearance) | Task 9: scenario `13-settings-drawer` (new) |
| P5 Task 5 Step 5 — stale-bearer 3-consecutive-401 guard | Task 8: scenario `14-auth-failure` (new) |
| P5 Task 10 Step 4 — full-flow smoke | natural superset of Tasks 5–10 once they all land |
| P3 Task 7 Step 4 — connection-lost banner + queued chat flush (P5.5 hotfix) | Task 7: scenario `12-chat-roundtrip` extended with disconnect step |
| Spec §1 invariant 2 — idle synthetic-last item (P5.5 hotfix) | Task 10: scenario `06-idle` asserts the IdleWaitingCard renders |
| Spec — `/demo` is the regression baseline | Task 10b: scenario `16-demo-cards` (new) drives `/demo`'s Cards step on each viewport |
| P4 multi-pending "Already handled on another device" toast — P4 Task 8 Step 5 manual core case | Task 6: REQUIRED step in `15-multi-pending` (was previously marked "(Optional, harder)" — promoted) |

---

## File structure after P6

```
e2e-real/
├── helpers/
│   ├── pwa-browser.ts             # NEW — Playwright browser launcher + login automation
│   ├── scenario.ts                # MODIFIED — adds `step(label, fn)` wrapper with auto-screenshot
│   ├── pwa-client.ts              # unchanged — kept for 10-perm-p95
│   └── (existing helpers untouched)
├── tests/
│   ├── 01-pair-and-snapshot.test.ts        # REWRITTEN with browser
│   ├── 02-permission-relay.test.ts         # REWRITTEN with browser
│   ├── 03-permission-deny.test.ts          # REWRITTEN with browser
│   ├── 04-history-scrollback.test.ts       # REWRITTEN with browser
│   ├── 05-task-completed.test.ts           # REWRITTEN with browser
│   ├── 06-idle.test.ts                     # REWRITTEN with browser
│   ├── 07-multi-daemon.test.ts             # REWRITTEN with browser
│   ├── 08-kill-session.test.ts             # REWRITTEN with browser
│   ├── 09-start-session.test.ts            # REWRITTEN with browser
│   ├── 10-perm-p95.test.ts                 # unchanged (keeps pwa-client)
│   ├── 11-offline-push.test.ts             # REWRITTEN with browser
│   ├── 12-chat-roundtrip.test.ts           # REWRITTEN with browser
│   ├── 13-settings-drawer.test.ts          # NEW
│   ├── 14-auth-failure.test.ts             # NEW
│   ├── 15-multi-pending.test.ts            # NEW
│   └── 16-demo-cards.test.ts               # NEW — /demo route visual baseline
├── screenshots/                            # tracked baselines, one dir per scenario
│   └── <scenario>/<step>.png               # synced from artifacts on success
├── artifacts/                              # NEW — gitignored (videos, traces, raw PNGs)
│   └── <run-timestamp>/
└── playwright.config.ts                    # NEW — viewports, timeouts, baseURL=vite preview
```

`packages/pwa/package.json` adds a `preview` script (`vite preview --port 4173 --host`) if not already present.

`.gitignore` gains `e2e-real/artifacts/` and `playwright-report/`.

---

## Task 1: Decide tooling shape; install Playwright

**Why:** Lock the dep + version + browser channel before any scenario uses it. Playwright wants its browsers downloaded out-of-band.

**Files:**
- Modify: `e2e-real/package.json`
- Create: `e2e-real/playwright.config.ts`
- Modify: `.gitignore`

- [ ] **Step 1: Add Playwright as a dev dep**

```bash
cd e2e-real
bun add -d @playwright/test
bunx playwright install chromium  # download just chromium; firefox/webkit come later if needed
```

- [ ] **Step 2: Write `e2e-real/playwright.config.ts`**

Config defaults: 1 worker (sequential — docker compose isn't multi-tenant-safe at this scope), `baseURL: http://localhost:4173`, retries: 0, `reporter: [['list'], ['html', { open: 'never' }]]`, viewports keyed off `RUN_VIEWPORTS` env (default `desktop`), timeout 60_000 per test, expect timeout 10_000.

```ts
import { defineConfig, devices } from "@playwright/test";

const VIEWPORT_PRESETS = {
  mobile:  { ...devices["iPhone 14"], viewport: { width: 390, height: 844 } },
  tablet:  { ...devices["iPad Mini"], viewport: { width: 768, height: 1024 } },
  desktop: { viewport: { width: 1280, height: 800 } },
};

const requested = (process.env.RUN_VIEWPORTS ?? "desktop").split(",").map((v) => v.trim());
const projects = requested.map((vp) => ({
  name: vp,
  use: VIEWPORT_PRESETS[vp as keyof typeof VIEWPORT_PRESETS] ?? VIEWPORT_PRESETS.desktop,
}));

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: { baseURL: "http://localhost:4173", trace: "on", video: "on" },
  projects,
});
```

- [ ] **Step 3: Update `.gitignore`**

Add at the bottom:
```
e2e-real/artifacts/
playwright-report/
e2e-real/test-results/
```

- [ ] **Step 4: Verify install**

```bash
cd e2e-real && bunx playwright --version
```
Expect a version line; no errors.

- [ ] **Step 5: Commit**

```bash
git add e2e-real/package.json e2e-real/playwright.config.ts .gitignore bun.lock
git commit -m "feat(e2e-real): add @playwright/test + chromium + config"
```

---

## Task 2: `vite preview` server lifecycle

**Why:** Playwright needs a live PWA to drive. `vite dev` is too noisy for tests; `vite preview` serves the production build deterministically.

**Files:**
- Modify: `packages/pwa/package.json`
- Create: `e2e-real/helpers/preview-server.ts`

- [ ] **Step 1: Confirm preview script**

Open `packages/pwa/package.json`. If `"preview"` script is missing or doesn't pass `--port 4173 --host`, add:
```json
"preview": "vite preview --port 4173 --host"
```

- [ ] **Step 2: Implement `preview-server.ts`**

```ts
import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const pwaDir = resolve(repoRoot, "packages", "pwa");

export interface PreviewHandle {
  baseURL: string;
  stop: () => Promise<void>;
}

/** Builds the PWA, then starts vite preview. Resolves once /index.html responds 200. */
export async function startPreview(): Promise<PreviewHandle> {
  // 1. Build (one-shot per test session is fine).
  await new Promise<void>((res, rej) => {
    const p = spawn("bun", ["run", "build"], { cwd: pwaDir, stdio: "inherit" });
    p.on("exit", (code) => (code === 0 ? res() : rej(new Error(`vite build exit ${code}`))));
  });

  // 2. Start preview.
  const child: ChildProcess = spawn("bun", ["run", "preview"], { cwd: pwaDir, stdio: ["ignore", "pipe", "pipe"] });
  const baseURL = "http://localhost:4173";

  // 3. Wait for ready.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(baseURL);
      if (r.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  if (Date.now() >= deadline) {
    child.kill();
    throw new Error("vite preview did not become ready within 30s");
  }

  return {
    baseURL,
    async stop() {
      child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 250));
    },
  };
}
```

- [ ] **Step 3: Verify the build + preview chain**

```bash
cd packages/pwa && bun run build && bun run preview &
sleep 3 && curl -s -o /dev/null -w '%{http_code}\n' http://localhost:4173
# expect 200
kill %1
```

- [ ] **Step 4: Commit**

```bash
git add packages/pwa/package.json e2e-real/helpers/preview-server.ts
git commit -m "feat(e2e-real): vite preview lifecycle helper for browser tests"
```

---

## Task 3: `helpers/pwa-browser.ts` — Playwright launcher + IAS login

**Why:** Replaces the manual fetch-redirect chain in `pwa-client.ts` with a real browser navigation. The IAS demo flow already auto-redirects (`fake-ias` /authorize 302s straight to /auth/callback), so the browser doesn't need user input — but it does need to be configured to accept fake-IAS hostnames the host can't resolve.

**Files:**
- Create: `e2e-real/helpers/pwa-browser.ts`

- [ ] **Step 1: Implement the helper**

```ts
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  bearer: string;
  close: () => Promise<void>;
}

/**
 * Launches chromium, signs in via /auth/login → fake-IAS → /auth/callback,
 * waits for the AppShell to render (post-bearer state). Returns the bearer
 * pulled from localStorage so scenarios can also drive WS asserts if needed.
 *
 * The fake-IAS issuer URL (`http://fake-ias:7770`) is host-unresolvable. The
 * browser hits the hub container at localhost:7745, which proxies the
 * authorize request internally — the same trick `pwa-client.ts` uses.
 */
export async function openPwa(opts: {
  baseURL: string;          // e.g. http://localhost:4173
  hub_http: string;         // e.g. http://localhost:7745
  artifactsDir: string;     // for video/trace
}): Promise<BrowserSession> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    baseURL: opts.baseURL,
    recordVideo: { dir: opts.artifactsDir },
  });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });

  const page = await context.newPage();
  // Inject HUB_URL via VITE_HUB_URL — vite preview reads from build-time env, so
  // ensure the build was made with VITE_HUB_URL=ws://localhost:7745. (Task 2
  // step 3 should set this in the build call.)

  // Click sign-in.
  await page.goto("/");
  await page.getByTestId("sign-in-screen").waitFor({ timeout: 10_000 });
  await page.getByRole("link", { name: "Sign in" }).click();

  // The login chain is server-side 302s; once it completes, the PWA's
  // consumeFragment writes the bearer to localStorage and re-renders.
  await page.getByTestId("home-screen").waitFor({ timeout: 30_000 });

  const bearer = await page.evaluate(() => localStorage.getItem("cc_remote_bearer")) ?? "";

  return {
    browser,
    context,
    page,
    bearer,
    async close() {
      await context.tracing.stop({ path: `${opts.artifactsDir}/trace.zip` });
      await context.close();
      await browser.close();
    },
  };
}
```

- [ ] **Step 2: Verify the helper compiles**

```bash
cd e2e-real && bunx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add e2e-real/helpers/pwa-browser.ts
git commit -m "feat(e2e-real): pwa-browser.ts Playwright launcher + IAS login"
```

---

## Task 4: Extend `helpers/scenario.ts` — `step(label, fn)` with auto-screenshot

**Why:** Per spec §4.5.2 each scenario step auto-captures a PNG named `${seq}-${slug(label)}.png`. The wrapper plus a small archive sync (Task 12) is the entire visual-regression surface.

**Files:**
- Modify: `e2e-real/helpers/scenario.ts`

- [ ] **Step 1: Add the step API**

Append to `scenario.ts`:

```ts
import type { Page } from "@playwright/test";

export interface ScenarioContext {
  page: Page;
  artifactsDir: string;     // where step PNGs land (auto-created)
  scenarioSlug: string;     // e.g. "02-permission-relay"
  step: (label: string, fn: () => Promise<void>) => Promise<void>;
}

export function makeScenarioContext(opts: {
  page: Page;
  artifactsDir: string;
  scenarioSlug: string;
}): ScenarioContext {
  let seq = 0;
  return {
    page: opts.page,
    artifactsDir: opts.artifactsDir,
    scenarioSlug: opts.scenarioSlug,
    step: async (label: string, fn: () => Promise<void>) => {
      seq += 1;
      await fn();
      const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      const padded = String(seq).padStart(2, "0");
      const file = `${opts.artifactsDir}/${padded}-${slug}.png`;
      await opts.page.screenshot({ path: file, fullPage: false });
    },
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add e2e-real/helpers/scenario.ts
git commit -m "feat(e2e-real): scenario.step wrapper with auto-screenshot"
```

---

## Task 5: Convert `02-permission-relay.test.ts` to browser

**Why:** This scenario is the canonical permission round-trip and is the most representative pilot for the conversion. Spec §4.5.8 phases this in V1.

**Files:**
- Modify: `e2e-real/tests/02-permission-relay.test.ts`

- [ ] **Step 1: Rewrite the scenario**

Replace the WS-only assertions with browser steps:
1. `home-after-login` — `await page.getByTestId("home-screen").waitFor()`
2. `daemon-card-visible` — `await page.getByTestId("machine-card-${daemon_id}").waitFor()`
3. `session-opened` — click the session row; wait for `session-view`
4. `permission-mini-card` — provoke a tool that needs approval (existing scenario logic does this); wait for `permission-mini`
5. `permission-surface-open` — click `Review`; wait for `permission-surface[data-form="aside"]`
6. `permission-allowed` — click `Allow once`; assert `permission-surface` removed
7. `tool-result-rendered` — wait for the tool's result item in the timeline (a card matching the right text)

Each block wraps in `await scenario.step(label, async () => { ... })`.

Use the existing `pairAndStartDaemon` + `startClaudeTmux` helpers verbatim — only the PWA half changes.

- [ ] **Step 2: Run the converted scenario**

```bash
cd e2e-real && bunx playwright test tests/02-permission-relay.test.ts --project=desktop
```

Must pass on first attempt. If the daemon takes longer to surface than the existing 30s timeout, raise the per-step timeout (not the global default) for the slowest waits.

- [ ] **Step 3: Inspect screenshots**

```bash
ls e2e-real/artifacts/<latest-run>/02-permission-relay/
```

Expect 7 PNGs, one per step. Open `01-home-after-login.png` and confirm the AppShell + HomeScreen render correctly. Manually inspect; this is the human-review baseline per spec §4.5.5.

- [ ] **Step 4: Commit**

```bash
git add e2e-real/tests/02-permission-relay.test.ts
git commit -m "test(e2e-real): convert 02-permission-relay to Playwright browser"
```

---

## Task 6: Convert `03-permission-deny` + add `15-multi-pending`

**Why:** Deny path is the symmetric twin of Task 5. Multi-pending is the queue-advance + already-handled toast surface introduced by P4 — the manual smoke I told the subagent to skip.

**Files:**
- Modify: `e2e-real/tests/03-permission-deny.test.ts`
- Create: `e2e-real/tests/15-multi-pending.test.ts`

- [ ] **Step 1: Convert `03-permission-deny`**

Same shape as Task 5, ending with `Deny`; assert the timeline picks up a `permission-resolved` card with denied tone.

- [ ] **Step 2: Write `15-multi-pending`**

Boot two real claude sessions on the same daemon, each provoking a permission concurrently. Steps:
1. `home-with-two-pending` — wait for `permission-mini` to read "2 approvals waiting"
2. `surface-shows-1-of-2` — open surface, assert `permission-queue` reads `1 of 2 pending`
3. `advance-after-allow` — click Allow; assert queue text becomes `1 of 1 pending` (or surface closes if 1 left)
4. `surface-closes-when-empty` — allow the second; surface should auto-close
5. **REQUIRED — `already-handled-toast`**. Start a third pending, open surface for it, then have the daemon resolve it directly out-of-band (simulate "another device" by making the ws-side `pwa-client` from `helpers/pwa-client.ts` send the `permission_reply` for that request_id). Assert the visible toast text `"Already handled on another device."` and assert the surface either auto-advances to the next pending or auto-closes when empty. (Was previously marked Optional — promoted to required because it's the core P4 invariant; the queue advance without the toast doesn't prove the resolution-from-elsewhere path.)

- [ ] **Step 3: Run both**

```bash
cd e2e-real && bunx playwright test tests/03-permission-deny.test.ts tests/15-multi-pending.test.ts --project=desktop
```

- [ ] **Step 4: Commit**

```bash
git add e2e-real/tests/03-permission-deny.test.ts e2e-real/tests/15-multi-pending.test.ts
git commit -m "test(e2e-real): convert 03-deny and add 15-multi-pending"
```

---

## Task 7: Convert `01-pair-and-snapshot` + `12-chat-roundtrip`

**Why:** These are the smoke baselines — pairing-then-snapshot exercises the SignInScreen → AppShell transition; chat round-trip is the merged-timeline data path P3 introduced.

**Files:**
- Modify: `e2e-real/tests/01-pair-and-snapshot.test.ts`
- Modify: `e2e-real/tests/12-chat-roundtrip.test.ts`

- [ ] **Step 1: Rewrite `01-pair-and-snapshot`**

Steps: `01-sign-in-screen`, `02-after-login-home`, `03-daemon-card-rendered`. The bearer write happens inside `openPwa`; assert the `home-screen` testid appears and exactly one `machine-card-${daemon_id}`.

- [ ] **Step 2: Rewrite `12-chat-roundtrip`**

Steps:
1. `home-after-login`
2. `session-opened`
3. `chat-input-typed` — `page.getByTestId("chat-input").fill("hello claude")`
4. `chat-sent` — submit, assert the user bubble appears in `timeline`
5. `claude-response-rendered` — wait for an assistant card with non-empty text
6. **`disconnect-banner-appears`** — kill the hub container WS layer (e.g. `docker compose pause hub` then resume after the next step) OR call `await page.evaluate(() => { (window as any).__test_close_ws?.(); })` if the harness exposes a hook. Assert `data-testid="connection-banner"` is visible. Type a message and submit while disconnected — the banner's `data-testid="queued-count"` should read `1 queued`.
7. **`reconnect-flushes-queue`** — restore the WS, wait for the `connection-banner` to disappear, assert the queued message arrives in the chat log (the queued user-bubble appears) — covers spec §3.2 queued-flush invariant introduced by the P5.5 hotfix.

- [ ] **Step 3: Run both**

```bash
cd e2e-real && bunx playwright test tests/01-pair-and-snapshot.test.ts tests/12-chat-roundtrip.test.ts --project=desktop
```

- [ ] **Step 4: Commit**

```bash
git add e2e-real/tests/01-pair-and-snapshot.test.ts e2e-real/tests/12-chat-roundtrip.test.ts
git commit -m "test(e2e-real): convert 01-snapshot and 12-chat-roundtrip"
```

---

## Task 8: Add `14-auth-failure` (3-consecutive-401 guard)

**Why:** Covers the P5 Task 5 manual smoke I told the subagent to skip. Plants a stale bearer in localStorage, reloads, expects the guard to fire and the SignInScreen to surface with the "Session expired" notice.

**Files:**
- Create: `e2e-real/tests/14-auth-failure.test.ts`

- [ ] **Step 1: Write the scenario**

```ts
test("stale bearer triggers guard and lands on SignInScreen", async () => {
  const session = await openPwa({ ... });
  // 1. Plant a stale bearer.
  await session.page.evaluate(() => {
    localStorage.setItem("cc_remote_bearer", "stale.junk.token");
  });
  await session.page.reload();
  // 2. Wait up to 30s — backoff is exponential (500ms / 1s / 2s) so 3 closes ≈ 3.5s of total backoff.
  await session.page.getByTestId("sign-in-screen").waitFor({ timeout: 30_000 });
  // 3. Assert the orange notice is visible.
  await expect(session.page.getByText("Session expired")).toBeVisible();
  // 4. localStorage cleared.
  const bearer = await session.page.evaluate(() => localStorage.getItem("cc_remote_bearer"));
  expect(bearer).toBeNull();
});
```

- [ ] **Step 2: Run**

```bash
cd e2e-real && bunx playwright test tests/14-auth-failure.test.ts --project=desktop
```

- [ ] **Step 3: Commit**

```bash
git add e2e-real/tests/14-auth-failure.test.ts
git commit -m "test(e2e-real): 14-auth-failure — 3-consecutive-401 bearer-clear guard"
```

---

## Task 9: Add `13-settings-drawer` (P5 Task 3 deferred smoke)

**Why:** The Settings drawer's rename / revoke / push-pref toggle / appearance tri-state never got automated coverage. This task lands the missing scenario.

**Files:**
- Create: `e2e-real/tests/13-settings-drawer.test.ts`

- [ ] **Step 1: Write the scenario**

Steps:
1. `home-after-login`
2. `settings-opened` — click the gear icon in the header (or nav bell) → `settings-drawer` appears
3. `account-section-visible` — assert email + Sign out button visible
4. `device-rename` — pick a device card, click Rename, type, Save; assert list refreshes with new name
5. `push-pref-toggled` — click `Permission alerts`; assert the chip flips Off → On (or vice versa)
6. `appearance-changed` — click Light, then Dark, then System; assert the active variant chip moves
7. `drawer-closed` — click backdrop; `settings-drawer` removed

The device list comes from a real /devices API call — make sure `pairAndStartDaemon` ran first so there's at least one device.

- [ ] **Step 2: Run**

```bash
cd e2e-real && bunx playwright test tests/13-settings-drawer.test.ts --project=desktop
```

- [ ] **Step 3: Commit**

```bash
git add e2e-real/tests/13-settings-drawer.test.ts
git commit -m "test(e2e-real): 13-settings-drawer — rename/revoke/toggles/appearance"
```

---

## Task 10: Convert remaining scenarios `04`–`09` and `11`

**Why:** Closes V2 of spec §4.5.8 — every WS-only scenario except `10-perm-p95` becomes browser-driven.

**Files:**
- Modify: `e2e-real/tests/04-history-scrollback.test.ts` — assert `Load earlier events` button click triggers history backfill in the timeline.
- Modify: `e2e-real/tests/05-task-completed.test.ts` — assert `task-completed` card lands; the per-session badge increments.
- Modify: `e2e-real/tests/06-idle.test.ts` — provoke an idle state (real Claude finishes a turn → daemon emits `idle` frame). Assert (a) the synthetic last item renders the IdleWaitingCard's signature text `"How would you like to proceed"` (the SessionTimeline appends `<SessionTimelineItem marker="idle">` containing `<IdleWaitingCard />` per P5.5 hotfix; do not look for any new testid — assert by visible text) and (b) once the next user message is sent, the synthetic item disappears (idle flag cleared).
- Modify: `e2e-real/tests/07-multi-daemon.test.ts` — assert two `machine-card-*` testids present; pending badge sums correctly.
- Modify: `e2e-real/tests/08-kill-session.test.ts` — confirm-kill flow: trash icon → confirm → daemon reports session_close → row removed.
- Modify: `e2e-real/tests/09-start-session.test.ts` — DaemonCard cwd input → Start button → `session_open` arrives → row appears.
- Modify: `e2e-real/tests/11-offline-push.test.ts` — **scope clarification**: this scenario stays focused on the **push subscription registration** path (browser permission prompt → service worker → /push/subscribe → fake VAPID). The push-prefs UI toggles inside SettingsDrawer are covered by `13-settings-drawer.test.ts` instead (Task 9). Steps for 11 in the new browser path: open `/`, sign in, grant Notifications permission via `await context.grantPermissions(['notifications'])`, assert the post-registration log line / inbox state via the existing assertions; visual coverage is just the post-login home screen.

Each conversion is mechanical: replace `loginAndConnect` with `openPwa`, replace inbox-asserts with DOM-asserts via testids. Each ends with one commit per file:

```bash
git commit -m "test(e2e-real): convert <NN-name> to Playwright browser"
```

- [ ] **Step 1**: convert `04`
- [ ] **Step 2**: convert `05`
- [ ] **Step 3**: convert `06`
- [ ] **Step 4**: convert `07`
- [ ] **Step 5**: convert `08`
- [ ] **Step 6**: convert `09`
- [ ] **Step 7**: convert `11`
- [ ] **Step 8**: full run

```bash
cd e2e-real && bunx playwright test --project=desktop
```

Expect 14 scenarios green (12 originals minus `10` perf which still uses `pwa-client`, plus `13` / `14` / `15` new = 14 browser scenarios + 1 protocol-only).

---

## Task 10b: Add `16-demo-cards` (`/demo` route visual baseline)

**Why:** Spec calls `/demo` the regression baseline for the prototype. Today only the unit test `cards.test.tsx` covers each card's signature string; nothing exercises layout, composition, or cross-viewport rendering. This task plants a PNG baseline for the Cards step at all three viewports.

**Files:**
- Create: `e2e-real/tests/16-demo-cards.test.ts`

This scenario does NOT need docker / claude / daemons — it only navigates the demo's static fixtures. So it can run without `pairAndStartDaemon` / `startClaudeTmux`. It still uses the same `vite preview` server.

- [ ] **Step 1: Write the scenario**

```ts
import { test } from "@playwright/test";
import { startPreview } from "../helpers/preview-server";
import { makeScenarioContext } from "../helpers/scenario";
import { chromium } from "@playwright/test";

let preview: Awaited<ReturnType<typeof startPreview>>;
test.beforeAll(async () => { preview = await startPreview(); });
test.afterAll(async () => { await preview?.stop(); });

test("/demo cards step renders the full catalog", async ({ page }, testInfo) => {
  const artifactsDir = `${testInfo.outputDir}`;
  const scenario = makeScenarioContext({ page, artifactsDir, scenarioSlug: "16-demo-cards", projectName: testInfo.project.name });

  await scenario.step("home-step", async () => {
    await page.goto(`${preview.baseURL}/demo`);
    await page.getByText("Home").first().waitFor({ timeout: 10_000 });
  });

  await scenario.step("cards-step", async () => {
    // Click through guided demo steps until reaching Cards. The DemoApp
    // exposes a Next button; alternative: navigate directly via URL hash if
    // the demo supports it. If not, programmatically click the "Cards"
    // step label.
    await page.getByRole("button", { name: /Cards/ }).first().click();
    await page.getByText("Card anatomy, variants, states, and density rules.").waitFor({ timeout: 5_000 });
  });

  await scenario.step("catalog-tile-1-user-bubble", async () => {
    await page.getByText("Please add password reset flow").waitFor();
  });
  await scenario.step("catalog-tile-permission-required", async () => {
    await page.getByText("Permission required", { exact: false }).first().waitFor();
  });
  await scenario.step("catalog-tile-task-completed", async () => {
    await page.getByText("feat: add password reset flow").waitFor();
  });
});
```

This scenario auto-multiplies under `RUN_VIEWPORTS=mobile,tablet,desktop` (Task 11), giving 3 sets of PNGs per check.

- [ ] **Step 2: Run**

```bash
cd e2e-real && bunx playwright test tests/16-demo-cards.test.ts --project=desktop
```

- [ ] **Step 3: Commit**

```bash
git add e2e-real/tests/16-demo-cards.test.ts
git commit -m "test(e2e-real): 16-demo-cards — /demo route visual baseline"
```

---

## Task 11: Multi-viewport wrapper for typical paths (V3 of spec §4.5.8)

**Why:** Mobile and tablet renderings are the new failure mode introduced by P4's responsive grid; today they have zero automated coverage. Run the typical-path scenarios at all three viewports.

**Files:**
- Modify: `e2e-real/playwright.config.ts`
- (Tests are already shaped to run per project — no test-file changes.)

- [ ] **Step 1: Verify the project list reads `RUN_VIEWPORTS`**

```bash
cd e2e-real && RUN_VIEWPORTS=mobile,tablet,desktop bunx playwright test tests/01-pair-and-snapshot.test.ts tests/02-permission-relay.test.ts tests/12-chat-roundtrip.test.ts tests/16-demo-cards.test.ts
```

Expect 12 runs (4 scenarios × 3 viewports). Step screenshots gain a viewport suffix automatically — wire that up by reading `test.info().project.name` inside the `step` wrapper:

Update `helpers/scenario.ts` `step` to suffix:
```ts
const file = `${opts.artifactsDir}/${padded}-${slug}.${opts.projectName}.png`;
```

(Add `projectName` to `ScenarioContext`; populate from `test.info().project.name` in each scenario.)

- [ ] **Step 2: Commit**

```bash
git add e2e-real/helpers/scenario.ts
git commit -m "feat(e2e-real): multi-viewport step PNGs for typical paths"
```

---

## Task 12: Sync-on-success → `screenshots/<scenario>/`

**Why:** Visual regression policy per spec §4.5.5: reviewer eyeballs `git diff e2e-real/screenshots/`. To make that diff meaningful, we need to copy successful runs' PNGs into the tracked screenshots dir, overwriting prior baselines.

**Files:**
- Create: `e2e-real/helpers/sync-screenshots.ts`
- Modify: `e2e-real/playwright.config.ts` (add a global teardown)

- [ ] **Step 1: Implement sync**

```ts
// On scenario success, copy artifacts/<run>/<scenario>/*.png →
// screenshots/<scenario>/*.png. Failed scenarios skip the copy
// (avoid overwriting good baselines with bad images).
```

Read `test.info()` in an `afterEach` hook; if status === "passed", `cp` the PNGs to the tracked dir.

- [ ] **Step 2: Establish baselines**

Run the suite end-to-end on a clean tree, commit the produced PNGs as the initial baseline:

```bash
cd e2e-real && bunx playwright test --project=desktop
git add e2e-real/screenshots
git commit -m "test(e2e-real): initial screenshot baselines"
```

- [ ] **Step 3: Commit the sync helper**

```bash
git add e2e-real/helpers/sync-screenshots.ts e2e-real/playwright.config.ts
git commit -m "feat(e2e-real): sync passing PNGs to screenshots/ baseline"
```

---

## Task 13: README + `_summary.json` (V4 of spec §4.5.8)

**Why:** Each run should produce a JSON manifest of `{ runId, gitSha, branch, scenarios }` so CI can consume it; the README needs updating to describe the new run ergonomics.

**Files:**
- Modify: `e2e-real/README.md`
- Modify: `e2e-real/playwright.config.ts` (or a global teardown script)

- [ ] **Step 1: Emit `_summary.json`**

Global teardown writes one file per run with status counts.

- [ ] **Step 2: Update README**

Document:
- `bunx playwright test` (default desktop)
- `RUN_VIEWPORTS=mobile,tablet,desktop bunx playwright test` (multi-viewport)
- `ARCHIVE=0 bunx playwright test` (skip artifacts — for CI fast path)
- Visual regression workflow: `git diff e2e-real/screenshots/`
- Replace the "Acceptance baseline" line with the new test counts.

- [ ] **Step 3: Commit**

```bash
git add e2e-real/README.md e2e-real/playwright.config.ts
git commit -m "docs(e2e-real): document Playwright runtime + summary manifest"
```

---

## Task 14: Tag the rollout

- [ ] **Step 1: Final full-suite verification**

```bash
cd e2e-real && bunx playwright test
```
Expect everything green at desktop. (Mobile/tablet are exercised on the typical-path scenarios only.)

- [ ] **Step 2: Tag**

```bash
git tag plan-pwa-real-e2e
```

- [ ] **Step 3: Update `docs/TODO.md`**

Mark "Real E2E Playwright conversion" complete.

```bash
git add docs/TODO.md
git commit -m "docs: mark real-e2e Playwright conversion done"
```

---

## Open questions / risks

1. **Image flake.** PNGs are byte-fragile across OS + browser updates. Mitigation: reviewer eyeballs diff; no pixel-diff tooling. If flake becomes painful, evaluate `playwright-visual-comparisons` with a tolerance threshold — but only after at least one quarter of stable runs.
2. **Cost & time.** Each scenario adds ~10–30s for browser boot. Budget revision: ~5.4 min today → ~9 min after conversion. Acceptable. Multi-viewport runs are gated to typical paths only.
3. **Vite preview port collisions in CI.** If port 4173 is taken, `startPreview` should pick a free port; defer until first failure rather than premature.
4. **Bearer survives across reloads.** Auth-failure test plants a stale bearer; if the live IAS bearer is somehow shorter than the stale token used for the test, the heuristic still fires correctly because the criterion is "no frame received" not "bearer length". Verified by reading the implementation in the (now-renamed) `hooks/useHub.ts`.

## Out of scope

- Replacing the in-process `bun test e2e/` suite with browser scenarios. That suite is the fast merge gate; keeping it WS-only is intentional.
- Pixel-diff visual regression tooling (deferred to post-stability).
- Cross-browser (firefox/webkit) — chromium only in v1.
