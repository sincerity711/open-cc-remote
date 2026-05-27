// Scenario 22 — slash input helper.
//
// PWA receives slash_inventory after session bind, opens the SlashMenu by
// typing "/", picks /clear, and submits. The daemon receives a `cli_command`
// frame and attempts a tmux send-keys. fake-claude isn't running inside a
// real tmux pane (so SessionSnapshot.tmux_pane is null), which means the
// daemon logs "no tmux target" rather than actually invoking tmux — that
// log line proves the frame routed end-to-end (PWA → hub → daemon).

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
  await syncIfPassed(testInfo, "22-slash-helpers");
});

test("slash_inventory arrives, /clear submission lands in daemon as cli_command", async ({ page }, testInfo) => {
  test.setTimeout(180_000);

  const daemon_id = `slash-${Date.now()}`;
  const projectsRoot = mkdtempSync(join(tmpdir(), "ccr-slash-projects-"));
  const sessionCwd = "/private/tmp/cc-remote-mock-slash";
  const sessionId = "mock-slash-session";

  const handle = await pairAndStartDaemon({
    daemon_id,
    hub_url: "ws://localhost:7745",
    hub_http: "http://localhost:7745",
    extra_env: { CLAUDE_PROJECTS_DIR: projectsRoot },
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
    scenarioSlug: "22-slash-helpers",
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
      const sessionRow = sessionsList.locator(".bg-surface").first();
      await sessionRow.waitFor({ timeout: 30_000 });
      await sessionRow.click();
      await session.page.getByTestId("session-view").waitFor({ timeout: 5_000 });
    });

    // Typing "/" must surface the SlashMenu populated by the slash_inventory
    // frame the daemon emitted after bind. The three built-in entries
    // (/clear, /compact, /context) are guaranteed regardless of host
    // ~/.claude state.
    await sc.step("slash-menu-opens", async () => {
      await session.page.getByTestId("chat-input").fill("/");
      await session.page.getByTestId("slash-menu").waitFor({ timeout: 10_000 });
      await expect(session.page.getByTestId("slash-row-builtin:clear")).toBeVisible();
      await expect(session.page.getByTestId("slash-row-builtin:compact")).toBeVisible();
      await expect(session.page.getByTestId("slash-row-builtin:context")).toBeVisible();
    });

    await sc.step("slash-clear-submitted", async () => {
      // Trailing space closes the SlashMenu (filterEntries returns [] once
      // draft has args), so Enter submits the form instead of being eaten by
      // the menu's pick-entry keydown handler. Equivalent to a user typing
      // "/clear<space><Enter>".
      await session.page.getByTestId("chat-input").fill("/clear ");
      await session.page.getByTestId("chat-input").press("Enter");
    });

    // The daemon logs `cli_command: ...` either as a successful send-keys
    // or as "no tmux target" when fake-claude isn't running in tmux.
    // Either confirms the frame routed all the way through hub → daemon.
    await sc.step("cli-command-reached-daemon", async () => {
      const deadline = Date.now() + 10_000;
      let last = "";
      while (Date.now() < deadline) {
        last = handle.stderr();
        if (/cli_command:/.test(last)) return;
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error(`daemon stderr did not log cli_command within 10s. tail:\n${last.split("\n").slice(-40).join("\n")}`);
    });
  } finally {
    if (fakeClaude && fakeClaude.exitCode === null) {
      try { fakeClaude.kill("SIGTERM"); } catch {}
    }
    await session.close();
    await handle.cleanup();
    try { rmSync(projectsRoot, { recursive: true, force: true }); } catch {}
  }
});
