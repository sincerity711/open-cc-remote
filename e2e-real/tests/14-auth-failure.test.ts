// Scenario 14 — stale bearer triggers the 3-consecutive-frameless-close guard
// in useHub: clearBearer() runs, RealApp drops back to SignInScreen with
// the "Session expired" notice. Browser-driven Playwright variant per P6
// task 8.
//
// No docker compose / no hub: the guard fires regardless of hub state because
// the WS can't connect at all. Each connect attempt: ws.onerror → ws.close()
// → reconnect() with receivedAnyFrame=false → framelessOpens++. Backoff is
// 500/1000/2000ms; the third close triggers options.onAuthFailure within
// ~5–8s wall.

import { test, expect, chromium } from "@playwright/test";
import { startPreview, type PreviewHandle } from "../helpers/preview-server.ts";
import { makeScenarioContext } from "../helpers/scenario.ts";

let preview: PreviewHandle;

test.beforeAll(async () => {
  preview = await startPreview();
});

test.afterAll(async () => {
  await preview?.stop();
});

test("stale bearer triggers guard and lands on SignInScreen", async ({ page }, testInfo) => {
  test.setTimeout(120_000);

  // Drive our own browser: we need to plant the bearer via addInitScript
  // BEFORE the app boots, and we want a clean context (no shared state with
  // the playwright-injected page).
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

  // Plant the stale bearer so it's present on the very first navigation.
  await context.addInitScript(() => {
    localStorage.setItem("cc_remote_bearer", "stale.junk.token");
  });

  const sessionPage = await context.newPage();

  const sc = makeScenarioContext({
    page: sessionPage,
    artifactsDir: testInfo.outputDir,
    scenarioSlug: "14-auth-failure",
    projectName: testInfo.project.name,
  });

  try {
    await sc.step("planted-stale-bearer", async () => {
      await sessionPage.goto("/");
      // The stale bearer is non-null, so RealApp should NOT render
      // SignInScreen yet — it should mount AppShell and try to subscribe.
      // We don't strictly need to assert that intermediate state; we just
      // make sure the navigation happened.
      await sessionPage.waitForLoadState("domcontentloaded");
    });

    await sc.step("guard-fires-back-to-sign-in", async () => {
      // 3 frameless closes with backoff 500/1000/2000ms ≈ ~3.5–8s + connect-
      // refusal latency. Allow up to 30s.
      await sessionPage.getByTestId("sign-in-screen").waitFor({ timeout: 30_000 });
    });

    await sc.step("session-expired-notice-visible", async () => {
      await expect(
        sessionPage.getByText("Session expired, please sign in again."),
      ).toBeVisible();
    });

    await sc.step("bearer-cleared", async () => {
      const bearerAfter = await sessionPage.evaluate(
        () => localStorage.getItem("cc_remote_bearer"),
      );
      expect(bearerAfter).toBeNull();
    });
  } finally {
    if (traceOwned) {
      try {
        await context.tracing.stop({ path: `${testInfo.outputDir}/trace.zip` });
      } catch { /* best-effort */ }
    }
    await context.close();
    await browser.close();
  }
});
