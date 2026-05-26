// Scenario 13 — settings drawer: open via gear, exercise rename / push-pref
// toggle / appearance picker / drawer close. Browser-driven Playwright variant
// per P6 plan task 9.
//
// Needs at least one paired device row, so we run a real pair flow against the
// hub via pairAndStartDaemon. Same compose lifecycle as 02.
//
// CORS NOTE: the hub serves on http://localhost:7745, the PWA on
// http://localhost:4173 — cross-origin. The hub does NOT emit CORS headers,
// so the browser's preflight on `/devices` and `/push/preferences` fails
// (visible in-app as a "Failed to fetch" banner). The product itself doesn't
// surface this in the demo because demo runs vite-dev (proxy or same hostname
// is implied by ops). For the e2e harness we'd otherwise need to either add
// CORS to the hub or proxy via vite preview — both are out of scope for this
// scenario. Instead we use page.route() to intercept hub HTTP calls and
// forward them server-side (where CORS doesn't apply), then return the
// response with permissive CORS headers. This exercises the real PWA UI
// against the real hub semantics — only the transport hop is bridged.

import { test, expect } from "@playwright/test";
import { upCompose, downCompose } from "../helpers/compose.ts";
import { openPwa, installCorsBridge } from "../helpers/pwa-browser.ts";
import { startPreview, type PreviewHandle } from "../helpers/preview-server.ts";
import { pairAndStartDaemon, makeScenarioContext } from "../helpers/scenario.ts";
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
  await syncIfPassed(testInfo, "13-settings-drawer");
});

test("settings drawer: rename / push-pref toggle / appearance / close", async ({ page }, testInfo) => {
  test.setTimeout(180_000);

  const daemon_id = `settings-${Date.now()}`;
  const handle = await pairAndStartDaemon({
    daemon_id,
    hub_url: "ws://localhost:7745",
    hub_http: "http://localhost:7745",
  });

  // Drive our own browser via openPwa so we get the same auto-signed-in flow
  // the other browser scenarios use.
  await page.close();

  const session = await openPwa({
    baseURL: preview.baseURL,
    hub_http: "http://localhost:7745",
    artifactsDir: testInfo.outputDir,
  });

  // Bridge cross-origin REST calls to the hub: forward server-side and
  // re-emit the response with permissive CORS headers. Routes are matched
  // against the absolute hub URL the PWA fetches.
  await installCorsBridge(session.context, "http://localhost:7745");

  // openPwa already navigated and the initial useDevices fetch ran BEFORE
  // these route handlers were attached (failing with CORS). Reload so the
  // PWA re-mounts with the bridge in place.
  await session.page.reload();
  await session.page.getByTestId("home-screen").waitFor({ timeout: 30_000 });

  const sc = makeScenarioContext({
    page: session.page,
    artifactsDir: testInfo.outputDir,
    scenarioSlug: "13-settings-drawer",
    projectName: testInfo.project.name,
  });

  try {
    await sc.step("home-after-login", async () => {
      // openPwa already waits for home-screen, but re-assert for clarity and
      // to make the step appear in artifacts.
      await session.page.getByTestId("home-screen").waitFor({ timeout: 10_000 });
    });

    await sc.step("settings-opened", async () => {
      // Header gear has aria-label="Open settings"; DesktopNav has a separate
      // aria-label="Settings" gear. Use the header one (unique across the
      // shell).
      await session.page.getByRole("button", { name: "Open settings" }).click();
      await session.page.getByTestId("settings-drawer").waitFor({ timeout: 5_000 });
    });

    await sc.step("account-section-visible", async () => {
      // The account section renders the bearer's email (or "signed in") plus
      // a "Sign out" button inside the drawer.
      const drawer = session.page.getByTestId("settings-drawer");
      await expect(drawer.getByRole("heading", { name: "Account" })).toBeVisible();
      await expect(drawer.getByRole("button", { name: "Sign out" })).toBeVisible();
    });

    await sc.step("daemon-online-and-rename", async () => {
      const drawer = session.page.getByTestId("settings-drawer");
      await expect(drawer.locator('[aria-label="online"]').first()).toBeVisible({ timeout: 30_000 });

      const renameBtn = drawer.getByRole("button", { name: "Rename" }).first();
      await renameBtn.click();

      const newName = `renamed-${Date.now()}`;
      const input = drawer.locator("input").first();
      await input.fill(newName);
      await drawer.getByRole("button", { name: "Save" }).click();

      await expect(drawer.getByText(newName, { exact: false }).first()).toBeVisible({ timeout: 10_000 });
    });

    await sc.step("push-pref-toggled", async () => {
      const drawer = session.page.getByTestId("settings-drawer");
      const row = drawer.getByRole("button", { name: /Permission alerts/ });
      await row.waitFor({ timeout: 10_000 });

      // Default for "permission" is On (PREF_DEFAULT_TRUE). First click → Off.
      await expect(row).toContainText("On");
      await row.click();
      await expect(row).toContainText("Off", { timeout: 10_000 });
      // Click again to flip back On — proves both directions of the toggle.
      await row.click();
      await expect(row).toContainText("On", { timeout: 10_000 });
    });

    await sc.step("appearance-changed", async () => {
      const drawer = session.page.getByTestId("settings-drawer");
      const lightBtn = drawer.getByRole("button", { name: "Light", exact: true });
      const darkBtn = drawer.getByRole("button", { name: "Dark", exact: true });
      const systemBtn = drawer.getByRole("button", { name: "System", exact: true });

      // Active variant uses the "default" button variant (bg-primary). Click
      // each and assert it received the bg-primary class.
      await lightBtn.click();
      await expect(lightBtn).toHaveClass(/bg-primary/, { timeout: 5_000 });
      // Light mode: <html> must NOT carry the .dark class.
      await expect(session.page.locator("html")).not.toHaveClass(/(^|\s)dark(\s|$)/, { timeout: 5_000 });

      await darkBtn.click();
      await expect(darkBtn).toHaveClass(/bg-primary/, { timeout: 5_000 });
      // Dark mode: <html> must carry the .dark class so design tokens swap.
      await expect(session.page.locator("html")).toHaveClass(/(^|\s)dark(\s|$)/, { timeout: 5_000 });

      await systemBtn.click();
      await expect(systemBtn).toHaveClass(/bg-primary/, { timeout: 5_000 });
      // System mode: outcome depends on OS prefers-color-scheme; only assert
      // the click completed without throwing and the chip moved (above).
    });

    await sc.step("drawer-closed", async () => {
      // The backdrop IS the drawer testid wrapper; clicking it triggers
      // onClose. The inner <aside> stops propagation, so we click the
      // backdrop area NOT covered by the aside (far-left edge).
      const backdrop = session.page.getByTestId("settings-drawer");
      const box = await backdrop.boundingBox();
      if (!box) throw new Error("settings-drawer has no bounding box");
      await session.page.mouse.click(box.x + 4, box.y + box.height / 2);
      await expect(session.page.getByTestId("settings-drawer")).toHaveCount(0, { timeout: 5_000 });
    });
  } finally {
    await session.close();
    await handle.cleanup();
  }
});
