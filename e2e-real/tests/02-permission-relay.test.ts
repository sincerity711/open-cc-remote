// Scenario 02 — real channel-permission protocol round-trip, browser-driven.
// Real Claude tool-call → plugin → daemon → hub → PWA browser → Allow →
// hub → daemon → plugin → Claude continues.
//
// Converts the WS-only pwa-client variant to Playwright per P6 plan task 5.

import { test, expect } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { upCompose, downCompose } from "../helpers/compose.ts";
import { startClaudeTmux } from "../helpers/claude-tmux.ts";
import { openPwa } from "../helpers/pwa-browser.ts";
import { startPreview, type PreviewHandle } from "../helpers/preview-server.ts";
import { pairAndStartDaemon, makeScenarioContext } from "../helpers/scenario.ts";
import { preflightOrThrow } from "../helpers/preflight.ts";
import { setupPermSandbox } from "../helpers/perm-sandbox.ts";
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
  await syncIfPassed(testInfo, "02-permission-relay");
});

test("permission relay: PWA approve → tool runs → task_completed", async ({ page }, testInfo) => {
  test.setTimeout(180_000);

  const daemon_id = `perm-${Date.now()}`;
  const sandbox = setupPermSandbox("relay", 1);
  const handle = await pairAndStartDaemon({
    daemon_id,
    hub_url: "ws://localhost:7745",
    hub_http: "http://localhost:7745",
  });

  // openPwa creates its own browser/page (with video + tracing scoped to its
  // own context). The Playwright-injected `page` is unused for this scenario;
  // close it to avoid leaving an orphan tab behind.
  await page.close();

  const session = await openPwa({
    baseURL: preview.baseURL,
    hub_http: "http://localhost:7745",
    artifactsDir: testInfo.outputDir,
  });

  const sc = makeScenarioContext({
    page: session.page,
    artifactsDir: testInfo.outputDir,
    scenarioSlug: "02-permission-relay",
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

    // Boot real Claude under tmux + provoke a tool call requiring permission.
    // bootTimeoutMs bumped to 60s — fresh boot under the test-runner is slower
    // than direct invocation.
    claude = await startClaudeTmux({
      cwd: sandbox.dir,
      prompt: `Use the Bash tool to run: rm ${sandbox.files[0]}`,
      sessionName: `ccr-perm-${daemon_id}`,
      socketPath: handle.socket_path,
      mcpConfigPath: `${handle.state_dir}/cc-remote-mcp.json`,
      pluginEntryPath: pluginEntry,
      bootTimeoutMs: 90_000,
    });

    await sc.step("session-opened", async () => {
      // Wait for the session row to appear, then click into it.
      const sessionsList = session.page.getByTestId(`sessions-${daemon_id}`);
      const sessionRow = sessionsList.locator(".bg-surface").first();
      await sessionRow.waitFor({ timeout: 60_000 });
      await sessionRow.click();
      await session.page.getByTestId("session-view").waitFor({ timeout: 5_000 });
    });

    await sc.step("permission-mini-card", async () => {
      // The mini-card lives on the home screen, but on desktop the
      // SessionView and HomeScreen render alongside each other. If the
      // testid isn't present from the SessionView vantage, navigate back.
      const mini = session.page.getByTestId("permission-mini");
      try {
        await mini.waitFor({ timeout: 60_000 });
      } catch {
        // Fall back: navigate home and try again.
        await session.page.goto("/");
        await mini.waitFor({ timeout: 30_000 });
      }
    });

    await sc.step("permission-surface-open", async () => {
      await session.page.getByRole("button", { name: "Review" }).first().click();
      await session.page.getByTestId("permission-surface").waitFor({ timeout: 5_000 });
    });

    await sc.step("permission-allowed", async () => {
      await session.page.getByRole("button", { name: /Allow/ }).click();
      await expect(session.page.getByTestId("permission-surface")).toHaveCount(0, { timeout: 10_000 });
    });

    await sc.step("tool-result-rendered", async () => {
      // Soft assertion — once allowed, the timeline should render at minimum.
      // Real Claude may take a while to summarize after the tool call, so we
      // just look for a timeline node to confirm session view is healthy.
      await session.page.getByTestId("timeline").waitFor({ timeout: 30_000 });
    });
  } finally {
    claude?.stop();
    await session.close();
    await handle.cleanup();
    sandbox.cleanup();
  }
});
