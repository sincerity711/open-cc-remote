// Scenario 06 — task_completed + idle_window_ms quiet → daemon emits an
// `idle` session_state frame → PWA's session-row StatusChip flips to "Idle".
// On the next user turn the chip flips back (the daemon transitions to
// `working` on the new JSONL line). Browser-driven Playwright variant per
// P6 plan task 10.
//
// Idle-timer semantics (daemon): real Claude writes trailing metadata after
// `assistant end_turn`; daemon arms idle on end_turn and only cancels on a
// new user/assistant turn — so idle fires reliably.
//
// History note: this test originally asserted on a synthetic IdleWaitingCard
// rendered into the timeline. Commit 338a6fa removed that card (the chip in
// the home-row already conveys idle; the duplicate card was noise) — the
// chip is the new ground truth.

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
  await syncIfPassed(testInfo, "06-idle");
});

test("idle: session row chip flips to Idle after end_turn", async ({ page }, testInfo) => {
  test.setTimeout(240_000);

  const daemon_id = `idle-${Date.now()}`;
  const handle = await pairAndStartDaemon({
    daemon_id,
    hub_url: "ws://localhost:7745",
    hub_http: "http://localhost:7745",
    idle_window_ms: 3_000,
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
    scenarioSlug: "06-idle",
    projectName: testInfo.project.name,
  });

  let claude: { stop: () => void } | undefined;
  try {
    await sc.step("home-after-login", async () => {
      await session.page.getByTestId("home-screen").waitFor({ timeout: 30_000 });
    });

    claude = await startClaudeTmux({
      cwd: "/tmp",
      prompt: "say idle test",
      sessionName: `ccr-idle-${daemon_id}`,
      socketPath: handle.socket_path,
      mcpConfigPath: `${handle.state_dir}/cc-remote-mcp.json`,
      pluginEntryPath: pluginEntry,
    });

    const sessionsList = session.page.getByTestId(`sessions-${daemon_id}`);
    const sessionRow = sessionsList.locator(".bg-surface").first();

    await sc.step("session-opened", async () => {
      await sessionRow.waitFor({ timeout: 90_000 });
      await sessionRow.click();
      await session.page.getByTestId("session-view").waitFor({ timeout: 5_000 });
    });

    await sc.step("row-chip-flips-to-idle", async () => {
      // The home row stays visible side-by-side on desktop. Wait for the
      // StatusChip to read "Idle" — daemon transitions: working → idle 3s
      // after the assistant's end_turn turn.
      // Real Claude turn + idle window ≈ 30-90s budget.
      await expect(sessionRow.locator("text=/^Idle$/").first()).toBeVisible({ timeout: 120_000 });
    });

    // Note: we deliberately don't assert the inverse transition (Idle →
    // Working on PWA chat-input) here. Production path:
    //
    //   PWA → hub chat_send → daemon chat_send → plugin chat_in → Claude
    //   Code MCP `notifications/claude/channel` (channel feature loaded
    //   via --dangerously-load-development-channels server:cc-remote).
    //
    // Claude Code is supposed to auto-enqueue + start a fresh turn when
    // idle at the ❯ prompt, but empirically the queue-pop doesn't fire
    // reliably within reasonable test budgets when Claude is fully
    // settled. Test 12 (mock fake-claude --auto-reply --jsonl-mirror)
    // covers the chat round-trip half deterministically.
  } finally {
    claude?.stop();
    await session.close();
    await handle.cleanup();
  }
});
