// Scenario 17 — floating "New events ↓" pill.
//
// Spec §3.4 invariant: when the user has scrolled up in a session timeline
// (autoScroll === false) and new events arrive with jsonl_offset beyond the
// per-session lastSeen anchor (see useLastSeen), the SessionTimeline must
// render a clickable pill that scrolls to the bottom and re-enables
// auto-scroll (the autoScroll effect then advances the anchor and the pill
// dismisses).
//
// Pre-polish this scenario booted real claude and round-tripped two chat
// messages. That worked when claude replied via plain TEXT_MESSAGE chunks,
// but real claude now reaches for `mcp__cc-remote__reply` (the plugin's
// reply tool) — which fires a PreToolUse permission gate the moment claude
// answers the first chat. The PWA composer then locks ("Waiting for
// permission") and the second chat never lands in JSONL → unreadCount = 0
// → pill never shows. The race is unrelated to the pill behavior we
// actually want to test.
//
// Switched to the same mock-driven shape as 12-chat-roundtrip:
// fake-claude with --jsonl-mirror writes the user + assistant lines into
// the daemon's JSONL directly. No plugin, no permission gate, deterministic
// timing. We get a clean "first event lands → user scrolls up → second
// event lands → pill appears" cycle.

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
  await syncIfPassed(testInfo, "17-new-events-pill");
});

test("new events pill: appears while scrolled up, scrolls and dismisses on click", async ({ page }, testInfo) => {
  test.setTimeout(180_000);

  const daemon_id = `pill-${Date.now()}`;
  const projectsRoot = mkdtempSync(join(tmpdir(), "ccr-pill-projects-"));
  const sessionCwd = "/private/tmp/cc-remote-mock-pill";
  const sessionId = "mock-pill-session";

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
    scenarioSlug: "17-new-events-pill",
    projectName: testInfo.project.name,
  });

  let fakeClaude: ChildProcess | undefined;
  try {
    await sc.step("home-after-login", async () => {
      await session.page.getByTestId("home-screen").waitFor({ timeout: 30_000 });
    });

    // fake-claude --auto-reply + --jsonl-mirror: every chat_in lands as a
    // <channel> user line + a canned assistant line in the JSONL the
    // daemon is watching. No real model, no permission gate.
    fakeClaude = spawn(
      "bun",
      [
        fakeClaudeBin,
        "--session-id", sessionId,
        "--claude-session-id", sessionId,
        "--cwd", sessionCwd,
        "--socket", handle.socket_path,
        "--auto-reply", "ok",
        "--jsonl-mirror", "true",
      ],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CLAUDE_PROJECTS_DIR: projectsRoot } },
    );

    await sc.step("session-opened", async () => {
      const sessionsList = session.page.getByTestId(`sessions-${daemon_id}`);
      const sessionRow = sessionsList.getByTestId("session-row").first();
      await sessionRow.waitFor({ timeout: 60_000 });
      await sessionRow.click();
      await session.page.getByTestId("session-view").waitFor({ timeout: 5_000 });
    });

    // Send a first chat so the timeline has content. While at the bottom
    // the lastSeen anchor advances to the resulting jsonl_offset.
    await sc.step("first-chat-sent", async () => {
      await session.page.getByTestId("chat-input").fill("hi");
      await session.page.getByTestId("chat-input").press("Enter");
      await expect(session.page.getByTestId("timeline")).toContainText("hi", { timeout: 10_000 });
      // Wait for the auto-reply too — once it lands, lastSeen is fully
      // caught up and we know any future event will increment unreadCount.
      await expect(session.page.getByTestId("timeline")).toContainText("ok", { timeout: 10_000 });
    });

    await sc.step("force-scrolled-up", async () => {
      // Programmatically force scrollTop=0 and dispatch a scroll event so
      // SessionTimeline's onScroll handler runs and flips autoScroll=false.
      // We grow the inner content (synthesize a scrollable area) by bumping
      // min-height on the timeline children — necessary when the real
      // timeline content is shorter than the viewport.
      await session.page.evaluate(() => {
        const tl = document.querySelector('[data-testid="timeline"]') as HTMLElement | null;
        if (!tl) throw new Error("no [data-testid=timeline]");
        const inner = tl.firstElementChild as HTMLElement | null;
        if (inner) inner.style.minHeight = (tl.clientHeight + 2000) + "px";
        tl.scrollTop = 0;
        tl.dispatchEvent(new Event("scroll"));
      });
    });

    await sc.step("pill-appears-on-new-event", async () => {
      // While scrolled up, send a second chat. Both the user line and the
      // auto-reply will land via JSONL — both have offset > the frozen
      // lastSeen anchor → unreadCount > 0; while scrolled up the pill
      // must appear.
      const SECOND = `MSG-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      await session.page.getByTestId("chat-input").fill(SECOND);
      await session.page.getByTestId("chat-input").press("Enter");
      await session.page.getByTestId("timeline-jump-new").waitFor({ timeout: 30_000 });
      await expect(session.page.getByTestId("timeline-jump-new")).toBeVisible();
    });

    await sc.step("pill-scrolls-and-dismisses", async () => {
      await session.page.getByTestId("timeline-jump-new").click();
      // The click triggers smooth scroll to bottom + setAutoScroll(true);
      // the autoScroll effect then advances lastSeen → unreadCount=0 →
      // the pill must disappear.
      await expect(session.page.getByTestId("timeline-jump-new")).toHaveCount(0, {
        timeout: 5_000,
      });
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
