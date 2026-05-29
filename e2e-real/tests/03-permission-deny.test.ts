// Scenario 03 — same setup as 02 but the PWA denies the permission. After
// clicking Deny in the surface, the surface unmounts and the SessionView
// remains usable (timeline visible, composer unblocked).
//
// Browser-driven Playwright variant per P6 task 6.

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
  await syncIfPassed(testInfo, "03-permission-deny");
});

test("permission deny: PWA denies → surface closes, session remains healthy", async ({ page }, testInfo) => {
  test.setTimeout(240_000);

  const daemon_id = `permdeny-${Date.now()}`;
  const sandbox = setupPermSandbox("deny", 1);
  const handle = await pairAndStartDaemon({
    daemon_id,
    hub_url: "ws://localhost:7745",
    hub_http: "http://localhost:7745",
  });

  // openPwa creates its own browser/page; close the playwright-injected page.
  await page.close();

  const session = await openPwa({
    baseURL: preview.baseURL,
    hub_http: "http://localhost:7745",
    artifactsDir: testInfo.outputDir,
  });

  const sc = makeScenarioContext({
    page: session.page,
    artifactsDir: testInfo.outputDir,
    scenarioSlug: "03-permission-deny",
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
      cwd: sandbox.dir,
      prompt: `Use the Bash tool to run: rm ${sandbox.files[0]}`,
      sessionName: `ccr-permdeny-${daemon_id}`,
      socketPath: handle.socket_path,
      mcpConfigPath: `${handle.state_dir}/cc-remote-mcp.json`,
      pluginEntryPath: pluginEntry,
      bootTimeoutMs: 90_000,
    });

    await sc.step("session-opened", async () => {
      const sessionsList = session.page.getByTestId(`sessions-${daemon_id}`);
      const sessionRow = sessionsList.locator(".bg-surface").first();
      await sessionRow.waitFor({ timeout: 60_000 });
      await sessionRow.click();
      await session.page.getByTestId("session-view").waitFor({ timeout: 5_000 });
    });

    await sc.step("inline-permission-card", async () => {
      const card = session.page.getByTestId("inline-permission-card");
      try {
        await card.waitFor({ timeout: 60_000 });
      } catch {
        // tmux'd Claude can boot slowly on cold caches; nudging the page often
        // unsticks a stalled SSE connection. Re-navigate to home and back into
        // the session, then re-wait.
        await session.page.goto("/");
        await session.page.getByTestId(`machine-card-${daemon_id}`).waitFor({ timeout: 30_000 });
        const sessionsList = session.page.getByTestId(`sessions-${daemon_id}`);
        await sessionsList.locator(".bg-surface").first().click();
        await card.waitFor({ timeout: 30_000 });
      }
    });

    await sc.step("permission-denied", async () => {
      await session.page
        .getByTestId("inline-permission-card")
        .getByRole("button", { name: /^Deny$/ })
        .click();
      // Card unmounts after Deny is acked.
      await expect(session.page.getByTestId("inline-permission-card")).toHaveCount(0, {
        timeout: 10_000,
      });
    });

    await sc.step("session-still-healthy", async () => {
      // After Deny: card gone, no other PermissionSurface modal exists, and the
      // session timeline still renders.
      await expect(session.page.getByTestId("inline-permission-card")).toHaveCount(0);
      await session.page.getByTestId("timeline").waitFor({ timeout: 30_000 });
    });
  } finally {
    claude?.stop();
    await session.close();
    await handle.cleanup();
    sandbox.cleanup();
  }
});
