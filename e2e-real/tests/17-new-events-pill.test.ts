// Scenario 17 — floating "New events ↓" pill.
//
// Spec §3.4 invariant: when the user has scrolled up in a session timeline
// (autoScroll === false) and new events arrive with jsonl_offset beyond the
// per-session lastSeen anchor (see useLastSeen), the SessionTimeline must
// render a clickable pill that scrolls to the bottom and re-enables
// auto-scroll (the autoScroll effect then advances the anchor and the pill
// dismisses).
//
// Approach:
//   1. Boot real claude with the chat-priming prompt so we get a session
//      and the channel-reply tool wiring.
//   2. Open the session and send a first chat so the timeline has at least
//      one user bubble + assistant card. While at the bottom the lastSeen
//      anchor advances to the latest jsonl_offset.
//   3. Force the timeline scroll position to the top via evaluate() — this
//      flips `autoScroll` to `false` via the existing onScroll handler. We
//      do this even when content is shorter than the viewport (the onScroll
//      handler still fires from a programmatic scrollTop change).
//   4. Send a second chat. The round-tripped event has offset > lastSeen →
//      unreadCount > 0; while scrolled up the pill must appear.
//   5. Click the pill: it must scroll to bottom; the autoScroll effect
//      advances lastSeen, unreadCount returns to 0, and the pill dismisses.

import { test, expect } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { upCompose, downCompose } from "../helpers/compose.ts";
import { startClaudeTmux } from "../helpers/claude-tmux.ts";
import { openPwa } from "../helpers/pwa-browser.ts";
import { startPreview, type PreviewHandle } from "../helpers/preview-server.ts";
import { pairAndStartDaemon, makeScenarioContext } from "../helpers/scenario.ts";
import { preflightOrThrow } from "../helpers/preflight.ts";
import { syncIfPassed } from "../helpers/sync-screenshots.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const pluginEntry = resolve(repoRoot, "packages", "plugin", "src", "index.ts");

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
  test.setTimeout(240_000);

  const daemon_id = `pill-${Date.now()}`;
  const handle = await pairAndStartDaemon({
    daemon_id,
    hub_url: "ws://localhost:7745",
    hub_http: "http://localhost:7745",
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

  let claude: { stop: () => void } | undefined;
  try {
    await sc.step("home-after-login", async () => {
      await session.page.getByTestId("home-screen").waitFor({ timeout: 30_000 });
    });

    claude = await startClaudeTmux({
      cwd: "/tmp",
      prompt: "Acknowledge with the single word: ready.",
      sendPrompt: true,
      sessionName: `ccr-pill-${daemon_id}`,
      socketPath: handle.socket_path,
      mcpConfigPath: `${handle.state_dir}/cc-remote-mcp.json`,
      pluginEntryPath: pluginEntry,
    });

    await sc.step("session-opened", async () => {
      const sessionsList = session.page.getByTestId(`sessions-${daemon_id}`);
      const sessionRow = sessionsList.locator(".bg-surface").first();
      await sessionRow.waitFor({ timeout: 90_000 });
      await sessionRow.click();
      await session.page.getByTestId("session-view").waitFor({ timeout: 5_000 });
    });

    // Send a first chat so the timeline has content. We don't actually need
    // claude to reply — a single user bubble plus the channel-broadcast
    // event suffices for the timeline to be rendered with items.
    await sc.step("first-chat-sent", async () => {
      await session.page.getByTestId("chat-input").fill("hi");
      await session.page.getByTestId("chat-input").press("Enter");
      // The user bubble must appear in the timeline.
      await expect(session.page.getByTestId("timeline")).toContainText("hi", { timeout: 10_000 });
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
        // Add inline padding to force scrollable overflow.
        const inner = tl.firstElementChild as HTMLElement | null;
        if (inner) inner.style.minHeight = (tl.clientHeight + 2000) + "px";
        tl.scrollTop = 0;
        tl.dispatchEvent(new Event("scroll"));
      });
    });

    await sc.step("pill-appears-on-new-event", async () => {
      // While scrolled up, send a second chat. The round-tripped event has
      // jsonl_offset > the frozen lastSeen anchor → unreadCount > 0 → pill.
      // 60s timeout — real claude might still be mid-reply to "hi" when this
      // chat lands; the channel notification queues until claude's next
      // turn boundary, so the JSONL write that drives the pill can take
      // 15-30s in the worst case (vs. ~2s when idle). Mirrors the pattern
      // in scenario 12 (chat round-trip) which uses 30s for assistant reply.
      const SECOND = `MSG-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      await session.page.getByTestId("chat-input").fill(SECOND);
      await session.page.getByTestId("chat-input").press("Enter");
      await session.page.getByTestId("timeline-jump-new").waitFor({ timeout: 60_000 });
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
    claude?.stop();
    await session.close();
    await handle.cleanup();
  }
});
