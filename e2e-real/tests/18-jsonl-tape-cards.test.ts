// Scenario 18 — JSONL tape cards. Mock-driven (no real Claude); we replay
// canonical fixtures captured against real Claude Code 2.1.146 lines and
// assert that mergeTimeline + renderTimelineItem render the right cards.
//
// Setup pattern (adapted from e2e/transcript.test.ts):
//   1. Boot hub via docker compose + start vite preview.
//   2. Pair + start daemon with CLAUDE_PROJECTS_DIR set to a per-test tmpdir.
//   3. Pre-create the session JSONL file so the bind watcher attaches.
//   4. Spawn fake-claude over the daemon's unix socket so the session shows up.
//   5. Open PWA, click into the session row, then replayJsonlTape() each
//      fixture and assert the resulting cards.
//
// We intentionally use ONE long-lived daemon + ONE PWA tab. Each fixture
// targets a distinct session_id, so cards from different tapes don't bleed
// into each other in the timeline.

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
  await syncIfPassed(testInfo, "18-jsonl-tape-cards");
});

function encodeCwd(cwd: string): string {
  return (cwd.replace(/\/+$/, "") || "/").replace(/\//g, "-");
}

interface SessionTape {
  /** Distinct cwd per tape so each session lands in its own bind dir. */
  cwd: string;
  sessionId: string;
  tapeFile: string;
}

const TAPES = {
  bashSuccess: {
    cwd: "/private/tmp/cc-remote-mock-bash-success",
    sessionId: "mock-bash-success",
    tapeFile: "bash-success.jsonl",
  },
  bashFailure: {
    cwd: "/private/tmp/cc-remote-mock-bash-failure",
    sessionId: "mock-bash-failure",
    tapeFile: "bash-failure.jsonl",
  },
  readEdit: {
    cwd: "/private/tmp/cc-remote-mock-read-edit",
    sessionId: "mock-read-edit",
    tapeFile: "read-then-edit.jsonl",
  },
  thinking: {
    cwd: "/private/tmp/cc-remote-mock-thinking",
    sessionId: "mock-thinking-tool",
    tapeFile: "thinking-then-tool.jsonl",
  },
  longOutput: {
    cwd: "/private/tmp/cc-remote-mock-long-output",
    sessionId: "mock-long-output",
    tapeFile: "long-output.jsonl",
  },
} as const satisfies Record<string, SessionTape>;

interface FakeClaudeHandle {
  proc: ChildProcess;
  stop(): void;
}

function spawnFakeClaude(args: { sockPath: string; sessionId: string; cwd: string }): FakeClaudeHandle {
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
  return {
    proc,
    stop() {
      try { proc.kill("SIGTERM"); } catch {}
    },
  };
}

function prepareTape(projectsDir: string, tape: SessionTape): { jsonlPath: string; tapePath: string } {
  const sessionDir = join(projectsDir, encodeCwd(tape.cwd));
  mkdirSync(sessionDir, { recursive: true });
  const jsonlPath = join(sessionDir, `${tape.sessionId}.jsonl`);
  // Touch — bindJsonl picks this up via fs.watch on the parent dir.
  writeFileSync(jsonlPath, "");
  return { jsonlPath, tapePath: join(tapesDir, tape.tapeFile) };
}

test("scenario 18 — JSONL tape cards (mock-driven)", async ({ page }, testInfo) => {
  test.setTimeout(240_000);

  const daemon_id = `tape-${Date.now()}`;
  const projectsRoot = mkdtempSync(join(tmpdir(), "ccr-tape-projects-"));

  const handle = await pairAndStartDaemon({
    daemon_id,
    hub_url: "ws://localhost:7745",
    hub_http: "http://localhost:7745",
    extra_env: { CLAUDE_PROJECTS_DIR: projectsRoot },
  });

  // Use our own browser/context (mirrors scenario 02 pattern).
  await page.close();

  const session = await openPwa({
    baseURL: preview.baseURL,
    hub_http: "http://localhost:7745",
    artifactsDir: testInfo.outputDir,
  });

  const sc = makeScenarioContext({
    page: session.page,
    artifactsDir: testInfo.outputDir,
    scenarioSlug: "18-jsonl-tape-cards",
    projectName: testInfo.project.name,
  });

  const fakeClaudes: FakeClaudeHandle[] = [];

  try {
    await sc.step("home-after-login", async () => {
      await session.page.getByTestId("home-screen").waitFor({ timeout: 30_000 });
    });

    await sc.step("daemon-card-visible", async () => {
      await session.page.getByTestId(`machine-card-${daemon_id}`).waitFor({ timeout: 30_000 });
    });

    // ---- bash-success tape ----
    const bashSuccess = prepareTape(projectsRoot, TAPES.bashSuccess);
    const fcBs = spawnFakeClaude({
      sockPath: handle.socket_path,
      sessionId: TAPES.bashSuccess.sessionId,
      cwd: TAPES.bashSuccess.cwd,
    });
    fakeClaudes.push(fcBs);

    await sc.step("session-row-appears", async () => {
      const list = session.page.getByTestId(`sessions-${daemon_id}`);
      await list.locator(".bg-surface").first().waitFor({ timeout: 30_000 });
    });

    await sc.step("session-opened", async () => {
      const list = session.page.getByTestId(`sessions-${daemon_id}`);
      await list.locator(".bg-surface").first().click();
      await session.page.getByTestId("session-view").waitFor({ timeout: 5_000 });
    });

    await sc.step("bash-command-card", async () => {
      await replayJsonlTape({ jsonlPath: bashSuccess.jsonlPath, tapePath: bashSuccess.tapePath, lineDelayMs: 80 });
      // Wait for a Bash command card to render.
      const timeline = session.page.getByTestId("timeline");
      await expect(timeline).toBeVisible();
      await expect(timeline.locator("article", { hasText: "Bash" }).first()).toBeVisible({ timeout: 15_000 });
      await expect(timeline.locator("code", { hasText: "ls -F /tmp" }).first()).toBeVisible({ timeout: 15_000 });
      // Success pill.
      await expect(
        timeline.locator("article").locator("text=/^Success$/").first(),
      ).toBeVisible({ timeout: 15_000 });
    });

    // ---- bash-failure tape (different session — separate session row) ----
    const bashFail = prepareTape(projectsRoot, TAPES.bashFailure);
    const fcBf = spawnFakeClaude({
      sockPath: handle.socket_path,
      sessionId: TAPES.bashFailure.sessionId,
      cwd: TAPES.bashFailure.cwd,
    });
    fakeClaudes.push(fcBf);

    await sc.step("bash-failure-card", async () => {
      // Switch to the failure session via the home column.
      const failureRow = session.page.locator(
        `[data-testid="sessions-${daemon_id}"] >> text=cc-remote-mock-bash-failure`,
      ).first();
      await failureRow.waitFor({ timeout: 30_000 });
      await failureRow.click();
      await replayJsonlTape({ jsonlPath: bashFail.jsonlPath, tapePath: bashFail.tapePath, lineDelayMs: 80 });
      const timeline = session.page.getByTestId("timeline");
      await expect(
        timeline.locator("article").locator("text=/^Failed$/").first(),
      ).toBeVisible({ timeout: 15_000 });
    });

    // ---- read+edit tape ----
    const readEdit = prepareTape(projectsRoot, TAPES.readEdit);
    const fcRe = spawnFakeClaude({
      sockPath: handle.socket_path,
      sessionId: TAPES.readEdit.sessionId,
      cwd: TAPES.readEdit.cwd,
    });
    fakeClaudes.push(fcRe);

    await sc.step("read-edit-cards", async () => {
      const reRow = session.page.locator(
        `[data-testid="sessions-${daemon_id}"] >> text=cc-remote-mock-read-edit`,
      ).first();
      await reRow.waitFor({ timeout: 30_000 });
      await reRow.click();
      await replayJsonlTape({ jsonlPath: readEdit.jsonlPath, tapePath: readEdit.tapePath, lineDelayMs: 80 });
      const timeline = session.page.getByTestId("timeline");
      await expect(timeline.locator("article", { hasText: "Read" }).first()).toBeVisible({ timeout: 15_000 });
      await expect(timeline.locator("article", { hasText: "Edit" }).first()).toBeVisible({ timeout: 15_000 });
      await expect(timeline.locator("code", { hasText: "/tmp/notes.md" }).first()).toBeVisible({ timeout: 15_000 });
    });

    // ---- thinking tape ----
    const thinking = prepareTape(projectsRoot, TAPES.thinking);
    const fcTh = spawnFakeClaude({
      sockPath: handle.socket_path,
      sessionId: TAPES.thinking.sessionId,
      cwd: TAPES.thinking.cwd,
    });
    fakeClaudes.push(fcTh);

    await sc.step("thinking-card", async () => {
      const thRow = session.page.locator(
        `[data-testid="sessions-${daemon_id}"] >> text=cc-remote-mock-thinking`,
      ).first();
      await thRow.waitFor({ timeout: 30_000 });
      await thRow.click();
      await replayJsonlTape({ jsonlPath: thinking.jsonlPath, tapePath: thinking.tapePath, lineDelayMs: 80 });
      const timeline = session.page.getByTestId("timeline");
      await expect(timeline.locator("article", { hasText: "Reasoning" }).first()).toBeVisible({ timeout: 15_000 });
    });

    // ---- long-output tape ----
    const longOut = prepareTape(projectsRoot, TAPES.longOutput);
    const fcLo = spawnFakeClaude({
      sockPath: handle.socket_path,
      sessionId: TAPES.longOutput.sessionId,
      cwd: TAPES.longOutput.cwd,
    });
    fakeClaudes.push(fcLo);

    await sc.step("long-output-card", async () => {
      const loRow = session.page.locator(
        `[data-testid="sessions-${daemon_id}"] >> text=cc-remote-mock-long-output`,
      ).first();
      await loRow.waitFor({ timeout: 30_000 });
      await loRow.click();
      await replayJsonlTape({ jsonlPath: longOut.jsonlPath, tapePath: longOut.tapePath, lineDelayMs: 80 });
      const timeline = session.page.getByTestId("timeline");
      await expect(
        timeline.locator("article").locator("text=/View output \\(\\d+ lines\\)/").first(),
      ).toBeVisible({ timeout: 15_000 });
    });
  } finally {
    for (const fc of fakeClaudes) fc.stop();
    await session.close();
    await handle.cleanup();
    try { rmSync(projectsRoot, { recursive: true, force: true }); } catch {}
  }
});
