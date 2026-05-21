// Scenario 12 — chat round-trip with real claude, browser-driven.
//
// PWA chat-input → daemon → plugin → real claude → reply → broadcast → PWA
// timeline. Extends the WS-only original with the P5.5 hotfix coverage:
//   - Disconnect: setOffline(true) → connection-banner appears, queued chat
//     stays in the offline queue (queued-count = "1 queued").
//   - Reconnect: setOffline(false) → banner disappears, queued user-bubble
//     flushes into the timeline.
//
// Spec §3.2 invariant.

import { test, expect } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { upCompose, downCompose } from "../helpers/compose.ts";
import { startClaudeTmux } from "../helpers/claude-tmux.ts";
import { openPwa } from "../helpers/pwa-browser.ts";
import { startPreview, type PreviewHandle } from "../helpers/preview-server.ts";
import { pairAndStartDaemon, makeScenarioContext } from "../helpers/scenario.ts";
import { preflightOrThrow } from "../helpers/preflight.ts";
import * as tmux from "../helpers/tmux.ts";

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

test("chat round-trip + disconnect/reconnect flushes queued bubble", async ({ page }, testInfo) => {
  test.setTimeout(240_000);

  const daemon_id = `chat-${Date.now()}`;
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

  // Install a WebSocket tracker on the page so we can forcibly close the
  // active hub socket later. The init script runs on every navigation; we
  // reload after install (bearer is in localStorage and survives reload),
  // and from that point every `new WebSocket(...)` instance is registered.
  await session.context.addInitScript(() => {
    const W = window as unknown as { WebSocket: typeof WebSocket; __cc_ws_registry__?: WebSocket[] };
    W.__cc_ws_registry__ = [];
    const Orig = W.WebSocket;
    function TrackedWS(this: WebSocket, url: string, protocols?: string | string[]): WebSocket {
      const inst = new Orig(url, protocols);
      W.__cc_ws_registry__!.push(inst);
      return inst;
    }
    TrackedWS.prototype = Orig.prototype;
    (TrackedWS as unknown as { CONNECTING: number; OPEN: number; CLOSING: number; CLOSED: number }).CONNECTING = Orig.CONNECTING;
    (TrackedWS as unknown as { CONNECTING: number; OPEN: number; CLOSING: number; CLOSED: number }).OPEN = Orig.OPEN;
    (TrackedWS as unknown as { CONNECTING: number; OPEN: number; CLOSING: number; CLOSED: number }).CLOSING = Orig.CLOSING;
    (TrackedWS as unknown as { CONNECTING: number; OPEN: number; CLOSING: number; CLOSED: number }).CLOSED = Orig.CLOSED;
    W.WebSocket = TrackedWS as unknown as typeof WebSocket;
  });
  await session.page.reload();

  const sc = makeScenarioContext({
    page: session.page,
    artifactsDir: testInfo.outputDir,
    scenarioSlug: "12-chat-roundtrip",
    projectName: testInfo.project.name,
  });

  let claude: { stop: () => void; capturePane: () => string; sessionName: string } | undefined;
  try {
    await sc.step("home-after-login", async () => {
      await session.page.getByTestId("home-screen").waitFor({ timeout: 30_000 });
    });

    // Boot real claude with the same priming prompt as the WS-only original:
    // forward whatever channel content arrives by calling the reply tool.
    claude = await startClaudeTmux({
      cwd: "/tmp",
      prompt: "You are connected to cc-remote. When a `<channel source=\"cc-remote\">` message arrives, call the MCP tool `mcp__cc-remote__reply` with arguments {\"text\": <the exact channel content verbatim, no quotes, no prose>}. Acknowledge with the single word: ready.",
      sendPrompt: true,
      sessionName: `ccr-chat-${daemon_id}`,
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

    // Round-trip with a unique token so an assistant card containing it
    // proves channel content actually reached the model.
    const TOKEN = `KMR-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;

    await sc.step("chat-input-typed", async () => {
      await session.page.getByTestId("chat-input").fill(TOKEN);
    });

    await sc.step("chat-sent", async () => {
      await session.page.getByTestId("chat-input").press("Enter");
      // The user bubble carrying the token must appear in the timeline.
      await expect(session.page.getByTestId("timeline")).toContainText(TOKEN, { timeout: 10_000 });
    });

    // Trigger a turn so claude actually receives the channel injection.
    const triggerTurn = async () => {
      try {
        tmux.sendKeys(claude!.sessionName, "process pending channel messages now", false);
        await new Promise((r) => setTimeout(r, 300));
        tmux.sendEnter(claude!.sessionName);
      } catch { /* ignore */ }
    };
    setTimeout(() => { void triggerTurn(); }, 3_000);
    setTimeout(() => { void triggerTurn(); }, 35_000);
    setTimeout(() => { void triggerTurn(); }, 75_000);

    await sc.step("claude-response-rendered", async () => {
      // Wait for the assistant turn carrying the token. Two timeline items
      // contain the token: the user bubble (already asserted) and an
      // assistant card. We wait for >=2 occurrences to confirm both.
      await expect(async () => {
        const count = await session.page
          .getByTestId("timeline")
          .locator(`text=${TOKEN}`)
          .count();
        expect(count).toBeGreaterThanOrEqual(2);
      }).toPass({ timeout: 120_000, intervals: [1_000, 2_000, 5_000] });
    });

    // P5.5 hotfix coverage: disconnect path.
    //
    // Strategy:
    //   - addInitScript wrapper at top-of-test registers every WebSocket on
    //     `window.__cc_ws_registry__` so we have a handle on the live hub
    //     socket. We close it explicitly — setOffline alone is unreliable
    //     for tearing down existing sockets on chromium.
    //   - context.setOffline(true) blocks the auto-reconnect attempts at the
    //     TCP layer. We must beat the hook's frameless-open auth-failure
    //     timer (3 closes without onopen → onAuthFailure). Backoff is
    //     500 → 1000 → 2000ms, so we have ~3.5s before bail. We set offline
    //     for as short a window as possible: just long enough to assert the
    //     banner and queue.
    await sc.step("disconnect-banner-appears", async () => {
      await session.context.setOffline(true);
      await session.page.evaluate(() => {
        const W = window as unknown as { __cc_ws_registry__?: WebSocket[] };
        for (const ws of W.__cc_ws_registry__ ?? []) {
          try { ws.close(); } catch { /* noop */ }
        }
      });
      await session.page.getByTestId("connection-banner").waitFor({ timeout: 10_000 });

      // Submit a second short message while offline. It must NOT broadcast,
      // it must enter the offline queue. queued-count reads "1 queued".
      const QUEUED = "Q";
      await session.page.getByTestId("chat-input").fill(QUEUED);
      await session.page.getByTestId("chat-input").press("Enter");
      await expect(session.page.getByTestId("queued-count")).toHaveText(/1 queued/, { timeout: 3_000 });
    });

    await sc.step("reconnect-flushes-queue", async () => {
      await session.context.setOffline(false);
      // Banner clears once the next backoff tick opens a real connection.
      await expect(session.page.getByTestId("connection-banner")).toHaveCount(0, { timeout: 30_000 });
      // queue flushes via the connected→true useEffect, which fires
      // onSendChat for each queued msg → hub broadcasts chat from=pwa →
      // timeline renders a UserBubble whose body contains the queued text.
      await expect(session.page.getByTestId("queued-count")).toHaveCount(0, { timeout: 15_000 });
      // Locate UserBubble surfaces (className bg-primary-subtle is unique to
      // them in renderTimelineItem) and assert at least one renders the
      // queued "Q" body.
      await expect(async () => {
        const bubbles = session.page.getByTestId("timeline").locator(".bg-primary-subtle p");
        const texts = await bubbles.allTextContents();
        const hit = texts.some((t) => t.trim() === "Q");
        if (!hit) throw new Error(`no UserBubble with body "Q"; got bodies: ${JSON.stringify(texts)}`);
      }).toPass({ timeout: 30_000, intervals: [500, 1_000, 2_000] });
    });
  } catch (e) {
    if (claude) {
      try {
        process.stderr.write(`[scenario 12] failure; pane:\n${claude.capturePane()}\n`);
      } catch { /* ignore */ }
    }
    throw e;
  } finally {
    claude?.stop();
    await session.close();
    await handle.cleanup();
  }
});
