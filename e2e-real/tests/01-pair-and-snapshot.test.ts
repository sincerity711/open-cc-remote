// Scenario 01 — pair a daemon, run real claude, drive the PWA through manual
// sign-in so we can assert both the pre-bearer sign-in screen and the
// post-login daemon card. Browser-driven Playwright variant per P6 task 7.
//
// Smoke test for the whole infrastructure: docker compose up + admin pairing
// code + cc-remote pair + real claude + tmux + plugin MCP + PWA login + WSS.

import { test, expect } from "@playwright/test";
import { chromium } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname as osHostname } from "node:os";
import { upCompose, downCompose } from "../helpers/compose.ts";
import { startClaudeTmux } from "../helpers/claude-tmux.ts";
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
  await syncIfPassed(testInfo, "01-pair-and-snapshot");
});

test("pair-and-snapshot: sign-in screen → home with daemon card after real claude session", async ({ page }, testInfo) => {
  test.setTimeout(180_000);

  const daemon_id = `pair-snap-${Date.now()}`;
  const sessionName = `ccr-pair-${daemon_id}`;

  const handle = await pairAndStartDaemon({
    daemon_id,
    hub_url: "ws://localhost:7745",
    hub_http: "http://localhost:7745",
  });

  // Close the playwright-injected page — we drive our own browser so we can
  // assert the pre-bearer sign-in state before the auto-signin flow runs.
  await page.close();

  const browser = await chromium.launch({
    headless: true,
    args: ["--host-resolver-rules=MAP fake-ias 127.0.0.1"],
  });
  const context = await browser.newContext({
    baseURL: preview.baseURL,
    recordVideo: { dir: testInfo.outputDir },
  });
  let traceOwned = true;
  try {
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  } catch (e) {
    if ((e as Error).message?.includes("already started")) {
      traceOwned = false;
    } else {
      throw e;
    }
  }
  const sessionPage = await context.newPage();

  const sc = makeScenarioContext({
    page: sessionPage,
    artifactsDir: testInfo.outputDir,
    scenarioSlug: "01-pair-and-snapshot",
    projectName: testInfo.project.name,
  });

  let claude: { stop: () => void } | undefined;
  try {
    await sc.step("sign-in-screen", async () => {
      // Navigate without auto-signin: assert the SignInScreen is visible
      // BEFORE clicking Sign in. This is the pre-bearer state covered by the
      // original WS-only smoke test's "pwa unauthenticated" assertion.
      await sessionPage.goto("/");
      await expect(sessionPage.getByTestId("sign-in-screen")).toBeVisible({ timeout: 10_000 });
    });

    await sc.step("home-after-login", async () => {
      // Drive the IAS chain — the hub redirects through fake-ias which our
      // host-resolver-rules pin to 127.0.0.1.
      await sessionPage.getByRole("link", { name: "Sign in" }).click();
      await sessionPage.getByTestId("home-screen").waitFor({ timeout: 30_000 });
    });

    await sc.step("daemon-card-rendered", async () => {
      // The paired daemon should announce itself; the home screen renders
      // a machine-card keyed by daemon_id, with the host's hostname.
      const card = sessionPage.getByTestId(`machine-card-${daemon_id}`);
      await card.waitFor({ timeout: 30_000 });
      // Original snapshot assertion covered "daemon shows up with its
      // hostname"; the browser equivalent is to confirm the card text
      // contains the daemon host's hostname (set by the daemon itself).
      await expect(card).toContainText(osHostname(), { timeout: 10_000 });
    });

    // Boot real claude under tmux so the daemon publishes a session.
    claude = await startClaudeTmux({
      cwd: "/tmp",
      prompt: "say hi",
      sessionName,
      socketPath: handle.socket_path,
      mcpConfigPath: `${handle.state_dir}/cc-remote-mcp.json`,
      pluginEntryPath: pluginEntry,
    });

    await sc.step("session-row-visible", async () => {
      // Original scenario asserted snapshot/session_open contained the
      // daemon's session at protocol level. The browser equivalent is the
      // session row appearing under the daemon card.
      const sessionsList = sessionPage.getByTestId(`sessions-${daemon_id}`);
      const sessionRow = sessionsList.getByTestId("session-row").first();
      await sessionRow.waitFor({ timeout: 60_000 });
    });
  } finally {
    claude?.stop();
    if (traceOwned) {
      try {
        await context.tracing.stop({ path: `${testInfo.outputDir}/trace.zip` });
      } catch { /* best-effort */ }
    }
    await context.close();
    await browser.close();
    await handle.cleanup();
  }
});
