// Scenario 08 — daemon allow_kill: true; PWA trash icon → confirm Kill →
// daemon reports session_close → row removed. Browser-driven Playwright
// variant per P6 plan task 10.

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
  await syncIfPassed(testInfo, "08-kill-session");
});

test("kill session: trash icon → confirm → row removed", async ({ page }, testInfo) => {
  test.setTimeout(240_000);

  const daemon_id = `kill-${Date.now()}`;
  const handle = await pairAndStartDaemon({
    daemon_id,
    hub_url: "ws://localhost:7745",
    hub_http: "http://localhost:7745",
    allow_kill: true,
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
    scenarioSlug: "08-kill-session",
    projectName: testInfo.project.name,
  });

  let claude: { stop: () => void } | undefined;
  try {
    await sc.step("home-after-login", async () => {
      await session.page.getByTestId("home-screen").waitFor({ timeout: 30_000 });
    });

    claude = await startClaudeTmux({
      cwd: "/tmp",
      prompt: "count from 1 to 100, one per line, slowly",
      sessionName: `ccr-kill-${daemon_id}`,
      socketPath: handle.socket_path,
      mcpConfigPath: `${handle.state_dir}/cc-remote-mcp.json`,
      pluginEntryPath: pluginEntry,
    });

    await sc.step("session-row-visible", async () => {
      const sessionsList = session.page.getByTestId(`sessions-${daemon_id}`);
      await sessionsList.locator(".bg-surface").first().waitFor({ timeout: 90_000 });
    });

    await sc.step("trash-icon-clicked", async () => {
      // Click the per-row "Confirm kill <name>" ghost-button (the trash icon).
      const trashBtn = session.page.getByRole("button", { name: /^Confirm kill / }).first();
      await trashBtn.click();
      // The confirmation strip "Kill session?" appears.
      await expect(session.page.getByText("Kill session?")).toBeVisible({ timeout: 5_000 });
    });

    await sc.step("kill-confirmed-and-row-removed", async () => {
      // Click the danger-styled Kill button inside the confirmation strip.
      await session.page.getByRole("button", { name: "Kill", exact: true }).click();
      // Daemon kills the tmux session → emits session_close → PWA removes
      // the row. The sessions list either disappears (no sessions) or shows
      // "No active sessions." Wait for the bg-surface row to be gone.
      const sessionsList = session.page.getByTestId(`sessions-${daemon_id}`);
      await expect(sessionsList.locator(".bg-surface")).toHaveCount(0, { timeout: 30_000 });
    });
  } finally {
    claude?.stop();
    await session.close();
    await handle.cleanup();
  }
});
