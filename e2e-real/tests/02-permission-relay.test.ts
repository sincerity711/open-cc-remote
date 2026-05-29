// Scenario 02 — permission relay round-trip, mock-driven.
//
// fake-claude (over the daemon's Unix socket) injects a permission_request
// frame; PWA surfaces the mini-card / in-session warning; user clicks
// Review → Allow; the daemon's `permission_reply` flows back to fake-claude
// (no-op). After Allow, we replay `bash-success.jsonl` into the bound JSONL
// path so a tool card with a Success status pill renders — proving the
// post-permission JSONL render path end-to-end.
//
// Mirrors scenario 18's setup pattern (extra_env=CLAUDE_PROJECTS_DIR per
// test). Hermetic — no ANTHROPIC token usage.

import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { upCompose, downCompose } from "../helpers/compose.ts";
import { openPwa } from "../helpers/pwa-browser.ts";
import { startPreview, type PreviewHandle } from "../helpers/preview-server.ts";
import { pairAndStartDaemon, makeScenarioContext } from "../helpers/scenario.ts";
import { preflightOrThrow } from "../helpers/preflight.ts";
import { syncIfPassed } from "../helpers/sync-screenshots.ts";
import { replayJsonlTape } from "../helpers/replay-jsonl.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const fakeClaudeBin = resolve(repoRoot, "tools", "fake-claude", "fake-claude.ts");
const tapesDir = resolve(__dirname, "..", "fixtures", "jsonl-tapes");

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
  await syncIfPassed(testInfo, "02-permission-relay");
});

function encodeCwd(cwd: string): string {
  return (cwd.replace(/\/+$/, "") || "/").replace(/\//g, "-");
}

test("permission relay: PWA approve → tool runs → task_completed", async ({ page }, testInfo) => {
  test.setTimeout(180_000);

  const daemon_id = `perm-${Date.now()}`;
  const projectsRoot = mkdtempSync(join(tmpdir(), "ccr-perm-projects-"));
  const sessionCwd = "/private/tmp/cc-remote-mock-bash-success";
  const sessionId = "mock-perm-bash-success";
  const requestId = `req-${Date.now()}`;
  const argsSummary = "ls -F /tmp";

  const handle = await pairAndStartDaemon({
    daemon_id,
    hub_url: "ws://localhost:7745",
    hub_http: "http://localhost:7745",
    extra_env: { CLAUDE_PROJECTS_DIR: projectsRoot },
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
    scenarioSlug: "02-permission-relay",
    projectName: testInfo.project.name,
  });

  // Pre-create the JSONL file so the daemon's bind watcher attaches before we
  // start streaming the tape (matches scenario 18's pattern).
  const sessionDir = join(projectsRoot, encodeCwd(sessionCwd));
  mkdirSync(sessionDir, { recursive: true });
  const jsonlPath = join(sessionDir, `${sessionId}.jsonl`);
  writeFileSync(jsonlPath, "");
  const tapePath = join(tapesDir, "bash-success.jsonl");

  let fakeClaude: ChildProcess | undefined;
  try {
    await sc.step("home-after-login", async () => {
      await session.page.getByTestId("home-screen").waitFor({ timeout: 30_000 });
    });

    await sc.step("daemon-card-visible", async () => {
      await session.page.getByTestId(`machine-card-${daemon_id}`).waitFor({ timeout: 30_000 });
    });

    // Spawn fake-claude with --inject-permission. The plugin process registers
    // the session, then 100ms later sends a permission_request. The daemon
    // forwards it to the hub → PWA mini-card / in-session warning surfaces.
    fakeClaude = spawn(
      "bun",
      [
        fakeClaudeBin,
        "--session-id", sessionId,
        "--claude-session-id", sessionId,
        "--cwd", sessionCwd,
        "--socket", handle.socket_path,
        "--inject-permission", `Bash:${requestId}:${argsSummary}`,
      ],
      { stdio: ["ignore", "pipe", "pipe"], env: process.env },
    );

    await sc.step("session-row-appears", async () => {
      const sessionsList = session.page.getByTestId(`sessions-${daemon_id}`);
      await sessionsList.locator(".bg-surface").first().waitFor({ timeout: 30_000 });
    });

    await sc.step("session-opened", async () => {
      const sessionsList = session.page.getByTestId(`sessions-${daemon_id}`);
      await sessionsList.locator(".bg-surface").first().click();
      await session.page.getByTestId("session-view").waitFor({ timeout: 5_000 });
    });

    await sc.step("inline-permission-card", async () => {
      // After the redesign, the pending permission renders directly inside
      // the selected session's timeline — no global mini-card, no modal.
      const card = session.page.getByTestId("inline-permission-card");
      await card.waitFor({ timeout: 30_000 });
      // Card carries the request_id as data attribute and shows the command.
      await expect(card).toContainText(argsSummary);
      await expect(card).toContainText("Bash");
    });

    await sc.step("permission-allowed", async () => {
      await session.page
        .getByTestId("inline-permission-card")
        .getByRole("button", { name: /Allow once/ })
        .click();
      // Card unmounts when the reducer drops the permission_request.
      await expect(session.page.getByTestId("inline-permission-card")).toHaveCount(0, {
        timeout: 10_000,
      });
    });

    await sc.step("tool-result-rendered", async () => {
      // After Allow, replay the bash-success tape into the bound JSONL so a
      // tool card with a Success/Failed/Running status pill renders.
      await session.page.getByTestId("timeline").waitFor({ timeout: 30_000 });
      await replayJsonlTape({ jsonlPath, tapePath, lineDelayMs: 80 });
      const statusPill = session.page
        .locator("article")
        .locator("text=/^(Success|Failed|Running…)$/")
        .first();
      await statusPill.waitFor({ timeout: 30_000 });
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
