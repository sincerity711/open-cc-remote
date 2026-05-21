// Scenario 06 — task_completed + idle_window_ms quiet → idle frame surfaces
// → SessionTimeline appends a synthetic IdleWaitingCard. Browser-driven
// Playwright variant per P6 plan task 10.
//
// Per spec §1 invariant 2 / P5.5 hotfix: when the session is idle, the
// SessionTimeline appends `<SessionTimelineItem marker="idle">` containing
// `<IdleWaitingCard />` whose distinctive copy is "How would you like to
// proceed?". After the user sends a chat message, the idle flag clears (any
// new event drops idleSessions[k]) and the synthetic card disappears.
//
// Idle-timer semantics (daemon): real Claude writes trailing metadata after
// `assistant end_turn`; daemon arms idle on end_turn and only cancels on a
// new user/assistant turn — so idle fires reliably.

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
  await syncIfPassed(testInfo, "06-idle");
});

test("idle: synthetic IdleWaitingCard renders, clears on next chat", async ({ page }, testInfo) => {
  test.setTimeout(240_000);

  const daemon_id = `idle-${Date.now()}`;
  const handle = await pairAndStartDaemon({
    daemon_id,
    hub_url: "ws://localhost:7745",
    hub_http: "http://localhost:7745",
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
    scenarioSlug: "06-idle",
    projectName: testInfo.project.name,
  });

  let claude: { stop: () => void } | undefined;
  try {
    await sc.step("home-after-login", async () => {
      await session.page.getByTestId("home-screen").waitFor({ timeout: 30_000 });
    });

    claude = await startClaudeTmux({
      cwd: "/tmp",
      prompt: "say idle test",
      sessionName: `ccr-idle-${daemon_id}`,
      socketPath: handle.socket_path,
      mcpConfigPath: `${handle.state_dir}/cc-remote-mcp.json`,
      pluginEntryPath: pluginEntry,
    });

    await sc.step("session-opened", async () => {
      const sessionsList = session.page.getByTestId(`sessions-${daemon_id}`);
      const sessionRow = sessionsList.locator(".bg-surface").first();
      await sessionRow.waitFor({ timeout: 90_000 });
      await sessionRow.click();
      await session.page.getByTestId("session-view").waitFor({ timeout: 5_000 });
    });

    await sc.step("idle-card-renders", async () => {
      // Wait for the IdleWaitingCard's distinctive copy. The daemon emits
      // idle 3s after task_completed; the PWA appends the synthetic item.
      // Real Claude turn + 3s idle window ≈ 30-90s budget.
      await expect(session.page.getByText("How would you like to proceed?")).toBeVisible({
        timeout: 120_000,
      });
    });

    await sc.step("idle-card-clears-on-new-message", async () => {
      // Send a chat message; any new event clears the idle flag.
      await session.page.getByTestId("chat-input").fill("hello");
      await session.page.getByTestId("chat-input").press("Enter");
      // The user bubble appears and the idle card disappears.
      await expect(session.page.getByTestId("timeline")).toContainText("hello", { timeout: 10_000 });
      await expect(session.page.getByText("How would you like to proceed?")).toHaveCount(0, {
        timeout: 10_000,
      });
    });
  } finally {
    claude?.stop();
    await session.close();
    await handle.cleanup();
  }
});
