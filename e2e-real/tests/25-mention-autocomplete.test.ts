// Scenario 25 — @-mention path autocomplete in the chat composer.
//
// Live PWA ↔ hub ↔ daemon round-trip for fs_list, scoped to the SessionView
// composer. Typing "@" must surface `data-testid="mention-popover"` with
// folder/file suggestions resolved relative to the session's cwd.
//
// Setup quirks worth a comment:
//
// 1. The daemon's fs_list whitelist defaults to $HOME ∪ CC_REMOTE_FS_ROOTS.
//    fake-claude sessions live under /private/tmp by convention (see e.g.
//    22-slash-helpers.test.ts), which is OUTSIDE the default whitelist. We
//    pass `extra_env: { CC_REMOTE_FS_ROOTS: "/private/tmp:/tmp" }` so the
//    daemon will list our test cwd. This is e2e-only — production deploys
//    keep their own whitelist via the runtime env.
//
// 2. fake-claude only registers the session; it does NOT create cwd. We
//    pre-populate sessionCwd with two child dirs (`alpha/`, `apricot/`) so
//    the popover has deterministic content to filter against.
//
// We don't send the message — only assert composer state after click + Esc.

import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { upCompose, downCompose } from "../helpers/compose.ts";
import { openPwa } from "../helpers/pwa-browser.ts";
import { startPreview, type PreviewHandle } from "../helpers/preview-server.ts";
import { pairAndStartDaemon, makeScenarioContext } from "../helpers/scenario.ts";
import { preflightOrThrow } from "../helpers/preflight.ts";
import { syncIfPassed } from "../helpers/sync-screenshots.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const fakeClaudeBin = resolve(repoRoot, "tools", "fake-claude", "fake-claude.ts");

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
  await syncIfPassed(testInfo, "25-mention-autocomplete");
});

test("@-mention popover lists session cwd contents and filters", async ({ page }, testInfo) => {
  test.setTimeout(180_000);

  const daemon_id = `mention-${Date.now()}`;
  const projectsRoot = mkdtempSync(join(tmpdir(), "ccr-mention-projects-"));

  // Use a stable cwd path under /private/tmp; create it + a couple of
  // child directories so fs_list has deterministic content. /private/tmp
  // is NOT under $HOME so we widen the whitelist via CC_REMOTE_FS_ROOTS.
  const sessionCwd = mkdtempSync("/private/tmp/ccr-mention-cwd-");
  // Each top-level dir gets a child so the popover stays open after a click
  // accepts a directory (mention-autocomplete hides itself when the new
  // parent has 0 entries to disambiguate).
  for (const top of ["alpha", "apricot", "banana"]) {
    mkdirSync(join(sessionCwd, top, "nested"), { recursive: true });
  }
  const sessionId = "mock-mention-session";

  const handle = await pairAndStartDaemon({
    daemon_id,
    hub_url: "ws://localhost:7745",
    hub_http: "http://localhost:7745",
    extra_env: {
      CLAUDE_PROJECTS_DIR: projectsRoot,
      // E2E-only: widen the daemon's fs_list whitelist so the test session's
      // cwd (under /private/tmp, not $HOME) is listable. Production never
      // sets this — see daemon/src/fs-list.ts for the default policy.
      CC_REMOTE_FS_ROOTS: "/private/tmp:/tmp",
    },
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
    scenarioSlug: "25-mention-autocomplete",
    projectName: testInfo.project.name,
  });

  let fakeClaude: ChildProcess | undefined;
  try {
    await sc.step("home-after-login", async () => {
      await session.page.getByTestId("home-screen").waitFor({ timeout: 30_000 });
    });

    fakeClaude = spawn(
      "bun",
      [
        fakeClaudeBin,
        "--session-id", sessionId,
        "--claude-session-id", sessionId,
        "--cwd", sessionCwd,
        "--socket", handle.socket_path,
        "--jsonl-mirror", "true",
      ],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CLAUDE_PROJECTS_DIR: projectsRoot } },
    );

    await sc.step("session-opened", async () => {
      const sessionsList = session.page.getByTestId(`sessions-${daemon_id}`);
      const sessionRow = sessionsList.getByTestId("session-row").first();
      await sessionRow.waitFor({ timeout: 30_000 });
      await sessionRow.click();
      await session.page.getByTestId("session-view").waitFor({ timeout: 5_000 });
    });

    const chat = session.page.getByTestId("chat-input");

    await sc.step("mention-popover-opens", async () => {
      await chat.click();
      await chat.fill("@");
      // useFsList debounces 150ms; popover hides while suggestions empty.
      await expect(session.page.getByTestId("mention-popover")).toBeVisible({ timeout: 5_000 });
      // At least one suggestion should be rendered — we seeded three dirs.
      await expect(
        session.page.getByTestId("folder-suggestion").first(),
      ).toBeVisible({ timeout: 3_000 });
    });

    await sc.step("mention-popover-filters", async () => {
      // Append "ap" — should narrow to a single match: apricot/.
      await chat.focus();
      await session.page.keyboard.press("End");
      await session.page.keyboard.type("ap");
      await session.page.waitForTimeout(300);
      const names = await session.page
        .getByTestId("folder-suggestion")
        .evaluateAll((els) =>
          (els as HTMLElement[]).map((el) => el.dataset.name ?? ""),
        );
      for (const n of names) {
        expect(
          n.toLowerCase().startsWith("ap"),
          `every visible suggestion must start with 'ap' (got ${n})`,
        ).toBe(true);
      }
      expect(names, "expected at least apricot to match 'ap'").toContain("apricot");
    });

    await sc.step("click-folder-row", async () => {
      // Reset to "@" so we can click any seeded folder. (Easier than
      // navigating to a specific filtered match by mouse.)
      await chat.fill("@");
      await expect(session.page.getByTestId("mention-popover")).toBeVisible({ timeout: 3_000 });
      const first = session.page.getByTestId("folder-suggestion").first();
      const name = (await first.getAttribute("data-name")) ?? "";
      expect(name, "first folder must have data-name").toBeTruthy();
      await first.click();
      await expect(chat).toHaveValue(`@${name}/`);
      // Clicking a directory keeps the popover open so the user can drill
      // into its contents — give the refetch a moment.
      await session.page.waitForTimeout(300);
      await expect(session.page.getByTestId("mention-popover")).toBeVisible({ timeout: 3_000 });
    });

    await sc.step("escape-closes-popover", async () => {
      await chat.focus();
      await session.page.keyboard.press("Escape");
      await expect(session.page.getByTestId("mention-popover")).toBeHidden({ timeout: 3_000 });
    });
  } finally {
    if (fakeClaude && fakeClaude.exitCode === null) {
      try { fakeClaude.kill("SIGTERM"); } catch { /* noop */ }
    }
    await session.close();
    await handle.cleanup();
    try { rmSync(projectsRoot, { recursive: true, force: true }); } catch { /* noop */ }
    try { rmSync(sessionCwd, { recursive: true, force: true }); } catch { /* noop */ }
  }
});
