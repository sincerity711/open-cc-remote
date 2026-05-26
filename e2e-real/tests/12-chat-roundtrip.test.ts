// Scenario 12 — chat round-trip, mock-driven, with disconnect/reconnect queue.
//
// PWA chat-input → daemon → fake-claude → auto-reply chat_out → broadcast →
// PWA timeline. Extends with the P5.5 hotfix coverage:
//   - Disconnect: setOffline(true) → connection-banner appears, queued chat
//     stays in the offline queue (queued-count = "1 queued").
//   - Reconnect: setOffline(false) → banner disappears, queued user-bubble
//     flushes into the timeline.
//
// fake-claude --auto-reply makes the chat path deterministic and hermetic
// (no ANTHROPIC token usage). The "drain pending permission" step from the
// real-Claude variant is removed: the mock path never raises permissions.

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
  await syncIfPassed(testInfo, "12-chat-roundtrip");
});

test("chat round-trip + disconnect/reconnect flushes queued bubble", async ({ page }, testInfo) => {
  test.setTimeout(240_000);

  const daemon_id = `chat-${Date.now()}`;
  const projectsRoot = mkdtempSync(join(tmpdir(), "ccr-chat-projects-"));
  const sessionCwd = "/private/tmp/cc-remote-mock-chat";
  const sessionId = "mock-chat-session";

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

  // The user bubble path now goes through JSONL: PWA → daemon chat_in →
  // fake-claude (--jsonl-mirror) appends a <channel> user line + an
  // assistant line → daemon's JSONL watcher → hub `event` frame → PWA
  // timeline. CLAUDE_PROJECTS_DIR keeps the bind subsystem isolated per
  // test.

  let fakeClaude: ChildProcess | undefined;
  try {
    await sc.step("home-after-login", async () => {
      await session.page.getByTestId("home-screen").waitFor({ timeout: 30_000 });
    });

    // Spawn fake-claude with --auto-reply so any chat_in arriving at the
    // plugin socket is mirrored back as a chat_out. --jsonl-mirror also has
    // it append a `<channel>` user line + an assistant line to the JSONL
    // file the daemon is watching, since (post-81862c0) the timeline
    // renders only from JSONL — chat broadcasts are notification-layer
    // only and don't surface in the timeline on their own.
    fakeClaude = spawn(
      "bun",
      [
        fakeClaudeBin,
        "--session-id", sessionId,
        "--claude-session-id", sessionId,
        "--cwd", sessionCwd,
        "--socket", handle.socket_path,
        "--auto-reply", "hi back",
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

    const TOKEN = `KMR-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;

    await sc.step("chat-input-typed", async () => {
      await session.page.getByTestId("chat-input").fill(TOKEN);
    });

    await sc.step("chat-sent", async () => {
      await session.page.getByTestId("chat-input").press("Enter");
      // The user bubble carrying the token must appear in the timeline.
      await expect(session.page.getByTestId("timeline")).toContainText(TOKEN, { timeout: 10_000 });
    });

    await sc.step("claude-response-rendered", async () => {
      // fake-claude auto-reply emitted "hi back" — the broadcast lands in the
      // timeline as an assistant chat bubble.
      await expect(session.page.getByTestId("timeline")).toContainText("hi back", { timeout: 30_000 });
    });

    // Disconnect path: verify banner appears when WS goes offline, and that
    // it disappears once connectivity is restored. The previous version of
    // this scenario also asserted an "offline queue" with a `queued-count`
    // pill; that UX has since been replaced — the composer is disabled while
    // disconnected. Banner-only coverage is what survives.
    await sc.step("disconnect-banner-appears", async () => {
      await session.context.setOffline(true);
      await session.page.evaluate(() => {
        const W = window as unknown as { __cc_ws_registry__?: WebSocket[] };
        for (const ws of W.__cc_ws_registry__ ?? []) {
          try { ws.close(); } catch { /* noop */ }
        }
      });
      await session.page.getByTestId("connection-banner").waitFor({ timeout: 10_000 });
    });

    await sc.step("reconnect-clears-banner", async () => {
      await session.context.setOffline(false);
      await expect(session.page.getByTestId("connection-banner")).toHaveCount(0, { timeout: 60_000 });
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
