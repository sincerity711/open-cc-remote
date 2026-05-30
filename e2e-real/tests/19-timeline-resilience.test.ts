// Scenario 19 — timeline resilience.
//
// Two regressions this guards against:
//
//   A) Page reload mid-session must rebuild the timeline from JSONL via
//      request_history. Before the JSONL-as-sole-source refactor (81862c0)
//      the chat broadcast hid breakage in this path; now that JSONL is the
//      only render source, request_history is load-bearing.
//
//   B) A `<channel>` user line that landed in the JSONL *before* the daemon
//      finished its async bindJsonl race must still surface as a user bubble.
//      Before commit be741b4 the watcher started at the file's current EOF,
//      so any line written prior to bind (including the very write that
//      triggered the bind via fs.watch) was silently skipped — breaking
//      every PWA-injected prompt for fresh sessions.
//
// Mock-driven: we replay a JSONL "tape" via appendFileSync into the file the
// daemon is watching. No real Claude needed; this hammers the daemon ↔ hub ↔
// PWA event chain end-to-end.

import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
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
import { expandFirstToolGroup } from "../helpers/timeline.ts";

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
  await syncIfPassed(testInfo, "19-timeline-resilience");
});

function encodeCwd(cwd: string): string {
  return (cwd.replace(/\/+$/, "") || "/").replace(/\//g, "-");
}

function spawnFakeClaude(args: { sockPath: string; sessionId: string; cwd: string }): { proc: ChildProcess; stop(): void } {
  const proc = spawn(
    "bun",
    [
      fakeClaudeBin,
      "--session-id", args.sessionId,
      "--claude-session-id", args.sessionId,
      "--cwd", args.cwd,
      "--socket", args.sockPath,
    ],
    { stdio: ["ignore", "pipe", "pipe"], env: process.env },
  );
  return { proc, stop() { try { proc.kill("SIGTERM"); } catch {} } };
}

test("timeline survives page reload — request_history rebuilds the same cards", async ({ page }, testInfo) => {
  test.setTimeout(240_000);

  const daemon_id = `reload-${Date.now()}`;
  const projectsRoot = mkdtempSync(join(tmpdir(), "ccr-reload-projects-"));
  const cwd = "/private/tmp/cc-remote-mock-reload";
  const sessionId = "mock-reload";

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
    scenarioSlug: "19-timeline-resilience-reload",
    projectName: testInfo.project.name,
  });

  const sessionDir = join(projectsRoot, encodeCwd(cwd));
  mkdirSync(sessionDir, { recursive: true });
  const jsonlPath = join(sessionDir, `${sessionId}.jsonl`);
  writeFileSync(jsonlPath, "");
  const tapePath = join(tapesDir, "bash-success.jsonl");

  const fc = spawnFakeClaude({ sockPath: handle.socket_path, sessionId, cwd });

  try {
    await sc.step("home-after-login", async () => {
      await session.page.getByTestId("home-screen").waitFor({ timeout: 30_000 });
    });

    await sc.step("session-opened", async () => {
      const list = session.page.getByTestId(`sessions-${daemon_id}`);
      await list.getByTestId("session-row").first().waitFor({ timeout: 30_000 });
      await list.getByTestId("session-row").first().click();
      await session.page.getByTestId("session-view").waitFor({ timeout: 5_000 });
    });

    await sc.step("tape-replayed", async () => {
      await replayJsonlTape({ jsonlPath, tapePath, lineDelayMs: 80 });
      const timeline = session.page.getByTestId("timeline");
      // Tool calls fold into a collapsible group post-polish — expand
      // before asserting on per-tool article chrome.
      await expandFirstToolGroup(session.page);
      await expect(timeline.locator("article", { hasText: "Bash" }).first()).toBeVisible({ timeout: 15_000 });
      await expect(timeline.locator("code", { hasText: "ls -F /tmp" }).first()).toBeVisible({ timeout: 15_000 });
    });

    await sc.step("page-reload", async () => {
      await session.page.reload();
      // RealApp redirects unauthenticated tabs to /signin; the bearer is in
      // localStorage and persists across reload, so we land directly back on
      // home-after-login.
      await session.page.getByTestId("home-screen").waitFor({ timeout: 30_000 });
    });

    await sc.step("session-reopened", async () => {
      const list = session.page.getByTestId(`sessions-${daemon_id}`);
      await list.getByTestId("session-row").first().waitFor({ timeout: 30_000 });
      await list.getByTestId("session-row").first().click();
      await session.page.getByTestId("session-view").waitFor({ timeout: 5_000 });
    });

    await sc.step("timeline-rebuilt-from-history", async () => {
      // The live event ring is empty for this fresh PWA tab; the only path
      // that can populate the timeline now is request_history → daemon
      // readHistory of the JSONL file.
      const timeline = session.page.getByTestId("timeline");
      // History rebuild also lands tool events that fold into a group;
      // expand again on this fresh tab.
      await expandFirstToolGroup(session.page);
      await expect(timeline.locator("article", { hasText: "Bash" }).first()).toBeVisible({ timeout: 15_000 });
      await expect(timeline.locator("code", { hasText: "ls -F /tmp" }).first()).toBeVisible({ timeout: 15_000 });
      await expect(
        timeline.locator("article").locator("text=/^Success$/").first(),
      ).toBeVisible({ timeout: 15_000 });
    });
  } finally {
    fc.stop();
    await session.close();
    await handle.cleanup();
    try { rmSync(projectsRoot, { recursive: true, force: true }); } catch {}
  }
});

test("channel-injected user line written before bind still surfaces as a user bubble", async ({ page }, testInfo) => {
  test.setTimeout(240_000);

  const daemon_id = `chan-${Date.now()}`;
  const projectsRoot = mkdtempSync(join(tmpdir(), "ccr-chan-projects-"));
  const cwd = "/private/tmp/cc-remote-mock-channel";
  const sessionId = "mock-channel-reload";

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
    scenarioSlug: "19-timeline-resilience-channel",
    projectName: testInfo.project.name,
  });

  const sessionDir = join(projectsRoot, encodeCwd(cwd));
  mkdirSync(sessionDir, { recursive: true });
  const jsonlPath = join(sessionDir, `${sessionId}.jsonl`);

  // Reproduce the bind-time race: pre-populate the JSONL with the
  // <channel>...BODY</channel> user line + an assistant follow-up BEFORE
  // fake-claude registers (which is what triggers bindJsonl). With the
  // pre-fix watcher (startOffset=stat.size) these lines would be skipped.
  const tapePath = join(tapesDir, "channel-injection.jsonl");
  writeFileSync(jsonlPath, readFileSync(tapePath, "utf8"));

  const fc = spawnFakeClaude({ sockPath: handle.socket_path, sessionId, cwd });

  try {
    await sc.step("home-after-login", async () => {
      await session.page.getByTestId("home-screen").waitFor({ timeout: 30_000 });
    });

    await sc.step("session-row-appears", async () => {
      const list = session.page.getByTestId(`sessions-${daemon_id}`);
      await list.getByTestId("session-row").first().waitFor({ timeout: 30_000 });
      await list.getByTestId("session-row").first().click();
      await session.page.getByTestId("session-view").waitFor({ timeout: 5_000 });
    });

    await sc.step("user-bubble-with-stripped-body", async () => {
      // The <channel>...</channel> envelope must be stripped; the body
      // "please run the tests" should appear inside a UserBubble (which is
      // tone="primary" → bg-primary-subtle).
      await expect(async () => {
        const bubbles = session.page.getByTestId("timeline").locator(".bg-primary-subtle p");
        const texts = await bubbles.allTextContents();
        const hit = texts.some((t) => t.trim() === "please run the tests");
        if (!hit) throw new Error(`no UserBubble with stripped body; got: ${JSON.stringify(texts)}`);
      }).toPass({ timeout: 30_000, intervals: [500, 1_000, 2_000] });
    });

    await sc.step("envelope-not-leaked-as-text", async () => {
      // Negative assertion: the raw "<channel" prefix must NEVER appear in
      // the timeline — that would mean the strip path didn't run and the
      // user is seeing implementation detail.
      const timeline = await session.page.getByTestId("timeline").innerText();
      expect(timeline).not.toContain("<channel");
    });

    await sc.step("assistant-follow-up-rendered", async () => {
      // The assistant text in the same tape ("On it. Running the test suite
      // now.") is also part of the same drain — confirms the watcher didn't
      // stop after the channel line.
      await expect(session.page.getByTestId("timeline")).toContainText("Running the test suite now", { timeout: 15_000 });
    });
  } finally {
    fc.stop();
    await session.close();
    await handle.cleanup();
    try { rmSync(projectsRoot, { recursive: true, force: true }); } catch {}
  }
});
