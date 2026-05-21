// Scenario 16 — /demo route visual baseline.
//
// Pure UI navigation against vite preview: no daemon, no docker, no claude
// process, no network. Drives the guided demo (DemoApp) into the Cards step
// and asserts the catalog tile signatures the unit test
// (packages/pwa/tests/cards.test.tsx) already covers, taking a screenshot
// per step as a visual baseline.
//
// Navigation note: the default step is "home" with device="mobile", which
// means DesktopNav (the icon rail with aria-label="Cards") is NOT rendered.
// We click the GuideRail step button which has the visible label "Cards".

import { test, chromium } from "@playwright/test";
import { startPreview, type PreviewHandle } from "../helpers/preview-server.ts";
import { makeScenarioContext } from "../helpers/scenario.ts";

let preview: PreviewHandle;
test.beforeAll(async () => { preview = await startPreview(); });
test.afterAll(async () => { await preview?.stop(); });

test("/demo cards step renders the full catalog", async ({}, testInfo) => {
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

    await sc.step("home-step", async () => {
      await page.goto("/demo");
      // Initial step is "Home"; the GuideRail has a step button with that
      // label and the right pane shows the "Machines" heading.
      await page.getByRole("heading", { name: "Machines" }).first().waitFor({ timeout: 10_000 });
    });

    await sc.step("cards-step", async () => {
      // GuideRail button — the aside on the left lists each step's label;
      // the accessible name is the concatenation of the index span ("4")
      // plus label ("Cards") plus the description note. Match by the
      // "Card anatomy" note text since that's unique to the Cards step.
      await page.getByRole("button", { name: /Card anatomy/ }).click();
      await page.getByText("Session Timeline Card System").waitFor({ timeout: 5_000 });
    });

    // Catalog tile signatures — these match what the bun:test card unit test
    // already verifies as the visual contract.
    await sc.step("catalog-tile-user-bubble", async () => {
      await page.getByText("Please add password reset flow").first().waitFor();
    });
    await sc.step("catalog-tile-permission-required", async () => {
      await page.getByText("Permission required").first().waitFor();
    });
    await sc.step("catalog-tile-task-completed", async () => {
      await page.getByText("feat: add password reset flow").first().waitFor();
    });
    await sc.step("catalog-tile-bash", async () => {
      await page.getByText("pnpm test auth").first().waitFor();
    });
  } finally {
    await context.close();
    await browser.close();
  }
});
