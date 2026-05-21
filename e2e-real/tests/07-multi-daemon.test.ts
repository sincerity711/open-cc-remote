// Scenario 07 — 3 daemons concurrent, all surface to PWA via fake-claude.
// Browser-driven Playwright variant per P6 plan task 10.
//
// Boundary preserved: this scenario does NOT use real claude (the e2e-real
// boundary deliberately keeps the multi-daemon coverage cheap). The browser
// converted assertion: each paired daemon renders a separate machine-card.

import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { upCompose, downCompose } from "../helpers/compose.ts";
import { openPwa } from "../helpers/pwa-browser.ts";
import { startPreview, type PreviewHandle } from "../helpers/preview-server.ts";
import { pairAndStartDaemon, makeScenarioContext } from "../helpers/scenario.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const fakeClaude = resolve(repoRoot, "tools", "fake-claude", "fake-claude.ts");

let preview: PreviewHandle;

test.beforeAll(async () => {
  await upCompose();
  preview = await startPreview();
});

test.afterAll(async () => {
  await preview?.stop();
  await downCompose();
});

test("multi-daemon: all 3 daemon cards render in PWA", async ({ page }, testInfo) => {
  test.setTimeout(180_000);

  const ts = Date.now();
  const ids = [`md-${ts}-a`, `md-${ts}-b`, `md-${ts}-c`];
  const cwdRoot = mkdtempSync(join(tmpdir(), "ccr-md-"));

  const handles: Awaited<ReturnType<typeof pairAndStartDaemon>>[] = [];
  const fakes: ChildProcess[] = [];

  await page.close();

  const session = await openPwa({
    baseURL: preview.baseURL,
    hub_http: "http://localhost:7745",
    artifactsDir: testInfo.outputDir,
  });

  const sc = makeScenarioContext({
    page: session.page,
    artifactsDir: testInfo.outputDir,
    scenarioSlug: "07-multi-daemon",
    projectName: testInfo.project.name,
  });

  try {
    await sc.step("home-after-login", async () => {
      await session.page.getByTestId("home-screen").waitFor({ timeout: 30_000 });
    });

    for (const id of ids) {
      const h = await pairAndStartDaemon({
        daemon_id: id,
        hub_url: "ws://localhost:7745",
        hub_http: "http://localhost:7745",
      });
      handles.push(h);
    }

    for (const h of handles) {
      const fc = spawn("bun", [
        "run", fakeClaude,
        "--session-id", `s-${h.daemon_id}`,
        "--cwd", cwdRoot,
        "--socket", h.socket_path,
      ], { stdio: ["ignore", "pipe", "pipe"] });
      fakes.push(fc);
    }

    await sc.step("three-machine-cards-rendered", async () => {
      // Each daemon must render its own machine-card in the PWA.
      for (const id of ids) {
        await session.page.getByTestId(`machine-card-${id}`).waitFor({ timeout: 30_000 });
      }
      const count = await session.page.locator('[data-testid^="machine-card-"]').count();
      expect(count).toBeGreaterThanOrEqual(3);
    });
  } finally {
    for (const fc of fakes) {
      try { fc.kill("SIGTERM"); } catch { /* noop */ }
    }
    for (const h of handles) {
      await h.cleanup();
    }
    await session.close();
    rmSync(cwdRoot, { recursive: true, force: true });
  }
});
