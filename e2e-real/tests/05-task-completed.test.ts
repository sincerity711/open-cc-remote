// Scenario 05 — real Claude turn completes → task_completed frame surfaces to
// PWA → per-session badge increments. Folded in the idle-transition assertion
// (formerly scenario 06): after end_turn + idle_window the daemon emits
// session_state idle and the row's StatusChip flips to "Idle". Same Claude
// turn, no extra tokens — just a few extra seconds at the tail.
//
// Per useHub: task_completed only increments completedCounts (no timeline
// item is added). The visible signal is the SessionRow text on the home
// screen: "unread N · tasks T · …". After a successful Claude turn against
// a fresh session, T transitions from 0 → ≥1.

import { test, expect } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { upCompose, downCompose } from "../helpers/compose.ts";
import { startClaudeTmux } from "../helpers/claude-tmux.ts";
import { openPwa } from "../helpers/pwa-browser.ts";
import { startPreview, type PreviewHandle } from "../helpers/preview-server.ts";
import { pairAndStartDaemon, makeScenarioContext } from "../helpers/scenario.ts";
import { preflightOrThrow } from "../helpers/preflight.ts";
import { syncIfPassed } from "../helpers/sync-screenshots.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const pluginEntry = resolve(repoRoot, "packages", "plugin", "src", "index.ts");

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
  await syncIfPassed(testInfo, "05-task-completed");
});

test("task_completed: PWA badge increments after real Claude turn", async ({ page }, testInfo) => {
  test.setTimeout(240_000);

  const daemon_id = `tc-${Date.now()}`;
  const handle = await pairAndStartDaemon({
    daemon_id,
    hub_url: "ws://localhost:7745",
    hub_http: "http://localhost:7745",
    // Tighten idle window from default 30s to 3s so we don't add 30s to the
    // test budget while waiting for the FSM to fire idle.
    idle_window_ms: 3_000,
  });

  await page.close();

  const session = await openPwa({
    baseURL: preview.baseURL,
    hub_http: "http://localhost:7745",
    artifactsDir: testInfo.outputDir,
  });

  const sc = makeScenarioContext({
    page: session.page,
    artifactsDir: testInfo.outputDir,
    scenarioSlug: "05-task-completed",
    projectName: testInfo.project.name,
  });

  let claude: { stop: () => void } | undefined;
  try {
    await sc.step("home-after-login", async () => {
      await session.page.getByTestId("home-screen").waitFor({ timeout: 30_000 });
    });

    await sc.step("daemon-card-visible", async () => {
      await session.page.getByTestId(`machine-card-${daemon_id}`).waitFor({ timeout: 30_000 });
    });

    claude = await startClaudeTmux({
      cwd: "/tmp",
      prompt: "say done",
      sessionName: `ccr-tc-${daemon_id}`,
      socketPath: handle.socket_path,
      mcpConfigPath: `${handle.state_dir}/cc-remote-mcp.json`,
      pluginEntryPath: pluginEntry,
    });

    await sc.step("session-row-visible", async () => {
      const sessionsList = session.page.getByTestId(`sessions-${daemon_id}`);
      await sessionsList.locator(".bg-surface").first().waitFor({ timeout: 90_000 });
    });

    await sc.step("task-completed-badge-incremented", async () => {
      // After Claude finishes its turn, the daemon emits task_completed; the
      // PWA's per-session badge "tasks N" advances from 0 to ≥1.
      const sessionsList = session.page.getByTestId(`sessions-${daemon_id}`);
      const sessionRow = sessionsList.locator(".bg-surface").first();
      // Match "tasks 1", "tasks 2", … (NOT "tasks 0").
      await expect(sessionRow).toContainText(/tasks\s+[1-9]\d*/, { timeout: 120_000 });
    });

    await sc.step("row-chip-flips-to-idle", async () => {
      // Daemon arms idle on assistant end_turn and fires `idle` after
      // idle_window_ms (3s here). The session_state frame flips the home
      // row's StatusChip to "Idle". Folded in from the old scenario 06.
      const sessionsList = session.page.getByTestId(`sessions-${daemon_id}`);
      const sessionRow = sessionsList.locator(".bg-surface").first();
      await expect(sessionRow.locator("text=/^Idle$/").first()).toBeVisible({ timeout: 30_000 });
    });
  } finally {
    claude?.stop();
    await session.close();
    await handle.cleanup();
  }
});
