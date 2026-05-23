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
