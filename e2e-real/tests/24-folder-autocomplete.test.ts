// Scenario 24 — folder autocomplete on the HomeScreen cwd input.
//
// Live PWA ↔ hub ↔ daemon round-trip for the new fs_list frame. After login
// the daemon pairs and goes online; the DaemonCard renders a cwd input that
// is wired through PathAutocomplete. Typing "~/" must surface
// `data-testid="folder-suggestion"` rows populated from a real fs_list reply
// (the daemon expands "~" against $HOME and lists it; default whitelist
// includes $HOME, so no env override is needed for this test).
//
// We don't hardcode any directory name — we discover the first suggestion's
// `data-name` at runtime and assert the input value updates accordingly.
// That keeps the test portable across hosts whose $HOME contents differ.

import { test, expect } from "@playwright/test";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { upCompose, downCompose } from "../helpers/compose.ts";
import { openPwa } from "../helpers/pwa-browser.ts";
import { startPreview, type PreviewHandle } from "../helpers/preview-server.ts";
import { pairAndStartDaemon, makeScenarioContext } from "../helpers/scenario.ts";
import { preflightOrThrow } from "../helpers/preflight.ts";
import { syncIfPassed } from "../helpers/sync-screenshots.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
void __dirname;

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
  await syncIfPassed(testInfo, "24-folder-autocomplete");
});

test("HomeScreen cwd input → fs_list popover with folder suggestions", async ({ page }, testInfo) => {
  test.setTimeout(120_000);

  const daemon_id = `fsls-${Date.now()}`;
  const handle = await pairAndStartDaemon({
    daemon_id,
    hub_url: "ws://localhost:7745",
    hub_http: "http://localhost:7745",
  });

  // openPwa creates its own browser/page; close the playwright-injected one.
  await page.close();

  const session = await openPwa({
    baseURL: preview.baseURL,
    hub_http: "http://localhost:7745",
    artifactsDir: testInfo.outputDir,
  });

  const sc = makeScenarioContext({
    page: session.page,
    artifactsDir: testInfo.outputDir,
    scenarioSlug: "24-folder-autocomplete",
    projectName: testInfo.project.name,
  });

  try {
    await sc.step("home-after-login", async () => {
      await session.page.getByTestId("home-screen").waitFor({ timeout: 30_000 });
    });

    // Wait for the daemon card before typing — without it the PWA has no
    // daemon_id to address fs_list at.
    await sc.step("daemon-card-visible", async () => {
      await session.page.getByTestId(`machine-card-${daemon_id}`).waitFor({ timeout: 30_000 });
    });

    const card = session.page.getByTestId(`machine-card-${daemon_id}`);
    const cwdInput = card.getByRole("textbox");

    // Type "~/" rather than "/". The daemon's whitelist is $HOME ∪
    // CC_REMOTE_FS_ROOTS by default, and "~" expands to $HOME, so listing
    // "~" returns the home dir contents. Listing "/" would yield `forbidden`
    // unless the e2e harness sets CC_REMOTE_FS_ROOTS=/.
    await sc.step("popover-open-with-matches", async () => {
      await cwdInput.click();
      await cwdInput.fill("~/");
      // useFsList debounces 150ms before sending; allow the round-trip.
      await expect(
        session.page.getByTestId("path-autocomplete"),
      ).toBeVisible({ timeout: 5_000 });
      const firstFolder = session.page.getByTestId("folder-suggestion").first();
      await expect(firstFolder).toBeVisible({ timeout: 3_000 });
      // Locking the screenshot at the open-popover state — this is the
      // golden file e2e-real/screenshots/24-folder-autocomplete/02-popover-open-with-matches.desktop.png.
      // (sc.step's auto-screenshot writes here; sync-screenshots copies on pass.)
    });

    // Discover the first suggestion's directory name at runtime. The set
    // of directories under $HOME is host-specific (Documents, Downloads,
    // SAPDevelop, etc.) so we read whichever one the daemon returned first
    // rather than hardcoding.
    let pickedName = "";
    await sc.step("pick-first-folder", async () => {
      const firstFolder = session.page.getByTestId("folder-suggestion").first();
      pickedName = (await firstFolder.getAttribute("data-name")) ?? "";
      expect(pickedName, "first folder suggestion must have a data-name").toBeTruthy();
      await firstFolder.click();
      // After accept, value is "~/<name>/". The daemon resolves "~" so the
      // form-side input keeps the literal "~/" prefix.
      await expect(cwdInput).toHaveValue(`~/${pickedName}/`);
    });

    // Type a single character — the popover must refilter case-insensitively.
    // "i" is widely-applicable on macOS ($HOME usually contains an entry
    // starting with i, e.g. "iCloud"-something or various dotfiles), but
    // because we can't guarantee a match, we just assert that any visible
    // suggestion either starts with the typed char or that the popover
    // becomes hidden (filtered.length === 0 hides it in mode="dirs").
    await sc.step("filter-by-prefix", async () => {
      // Append "i" — easier than re-typing the full value.
      await cwdInput.focus();
      await session.page.keyboard.press("End");
      await session.page.keyboard.type("i");
      await session.page.waitForTimeout(300);
      const popoverVisible = await session.page
        .getByTestId("path-autocomplete")
        .isVisible()
        .catch(() => false);
      if (popoverVisible) {
        const names = await session.page
          .getByTestId("folder-suggestion")
          .evaluateAll((els) =>
            (els as HTMLElement[]).map((el) => el.dataset.name ?? ""),
          );
        for (const name of names) {
          expect(
            name.toLowerCase().startsWith("i"),
            `every visible suggestion must start with 'i' (got ${name})`,
          ).toBe(true);
        }
      }
      // else: no $HOME entry under "<pickedName>/" starts with i — that's
      // a valid empty-state and the popover is correctly hidden.
    });

    await sc.step("escape-closes-popover", async () => {
      await cwdInput.focus();
      await session.page.keyboard.press("Escape");
      await expect(session.page.getByTestId("path-autocomplete")).toBeHidden({ timeout: 3_000 });
    });
  } finally {
    await session.close();
    await handle.cleanup();
  }
});

// Reference $HOME so the import is exercised even if the test body changes.
void homedir;
