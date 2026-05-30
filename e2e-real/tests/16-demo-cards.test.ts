// Scenario 16 — /demo route visual baseline.
//
// Pure UI navigation against vite preview: no daemon, no docker, no claude
// process, no network. Switches the demo into the Catalog view and asserts
// the four-level card system surfaces (L0/L1/L2/L3) plus a few tile bodies
// to catch regressions in the catalog page itself.
//
// History: pre-polish this scenario drove the old "guided rail" demo into a
// "Cards" step that no longer exists. The polish pass replaced the rail with
// a Live ↔ Catalog toggle and made the catalog its own surface; this test
// follows that shape.

import { test, chromium } from "@playwright/test";
import { startPreview, type PreviewHandle } from "../helpers/preview-server.ts";
import { makeScenarioContext } from "../helpers/scenario.ts";
import { syncIfPassed } from "../helpers/sync-screenshots.ts";

let preview: PreviewHandle;
test.beforeAll(async () => { preview = await startPreview(); });
test.afterAll(async () => { await preview?.stop(); });

test.afterEach(async ({}, testInfo) => {
  await syncIfPassed(testInfo, "16-demo-cards");
});

test("/demo catalog view renders all four elevation levels", async ({}, testInfo) => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ baseURL: preview.baseURL });
  const page = await context.newPage();
  try {
    const sc = makeScenarioContext({
      page,
      artifactsDir: testInfo.outputDir,
      scenarioSlug: "16-demo-cards",
      projectName: testInfo.project.name,
    });

    await sc.step("live-view-default", async () => {
      await page.goto("/demo");
      // Default view is Live — the app shell is mounted with a Machines pane.
      await page.getByRole("heading", { name: "Machines" }).first().waitFor({ timeout: 10_000 });
    });

    await sc.step("switch-to-catalog", async () => {
      await page.getByRole("tab", { name: /^Catalog$/ }).click();
      await page.getByRole("heading", { name: /Every card variant/ }).waitFor({ timeout: 5_000 });
    });

    // Section headers — one per elevation level. These are the spine of the
    // catalog: if any drop out the page is no longer fulfilling its purpose.
    await sc.step("section-l1-surface", async () => {
      await page.getByRole("heading", { name: "Surface cards" }).waitFor();
    });
    await sc.step("section-l1-conversation", async () => {
      await page.getByRole("heading", { name: "Conversation cards" }).waitFor();
    });
    await sc.step("section-l2-rows", async () => {
      await page.getByRole("heading", { name: "Nested rows" }).waitFor();
    });
    await sc.step("section-l3-chips", async () => {
      await page.getByRole("heading", { name: "Inline chips & badges" }).waitFor();
    });
    await sc.step("section-l0-sheets", async () => {
      await page.getByRole("heading", { name: "Sheets & overlays" }).waitFor();
    });

    // Tile-body samples — verify the catalog is composing the real primitives,
    // not stub markup. If these break the catalog has lost its "always in
    // sync with production" property.
    await sc.step("tile-permission-inline", async () => {
      // InlinePermissionCard renders a tokenized rm -rf node_modules + Risk row.
      await page.getByText("recursive delete").first().waitFor();
    });
    await sc.step("tile-assistant-bubble", async () => {
      await page.getByText(/Issue a hashed token/).first().waitFor();
    });
    await sc.step("tile-tool-group-many", async () => {
      // The "Ran 4 commands" group header proves grouping is wired in catalog.
      await page.getByText(/Ran 4 commands/).first().waitFor();
    });
    await sc.step("tile-status-chip-row", async () => {
      // L3 chips row exposes every StatusChip tone — Working has the
      // breathing dot; the label itself is plain text we can wait on.
      await page.getByText(/^Working$/).first().waitFor();
    });
  } finally {
    await context.close();
    await browser.close();
  }
});
