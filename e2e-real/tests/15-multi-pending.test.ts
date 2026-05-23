// Scenario 15 — multi-pending permission queue + already-handled toast.
//
// Boots three real claude sessions on the same daemon, sequentially. Each
// session provokes a tool requiring permission, producing concurrent pending
// requests in the PWA. Drives the surface through the queue and exercises
// the out-of-band-resolution toast.
//
// Flow:
//   - Boot Claude A and Claude B → home shows "2 approvals waiting".
//   - Surface opens reading "1 of 2 pending".
//   - Allow A → surface advances to B. With only B remaining, the queue
//     line is hidden (the surface only renders it when queueSize > 1).
//   - While B is still active in the surface, boot Claude C → queue grows
//     back to 2. An out-of-band WS-only "device" approves the active request
//     (B). The browser observes the resolution: usePermissionQueue fires the
//     "Already handled on another device." toast and advances to C.
//   - Allow C → surface closes.

import { test, expect } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { upCompose, downCompose } from "../helpers/compose.ts";
import { startClaudeTmux, type ClaudeTmuxHandle } from "../helpers/claude-tmux.ts";
import { openPwa } from "../helpers/pwa-browser.ts";
import { loginAndConnect } from "../helpers/pwa-client.ts";
import { startPreview, type PreviewHandle } from "../helpers/preview-server.ts";
import { pairAndStartDaemon, makeScenarioContext } from "../helpers/scenario.ts";
import { preflightOrThrow } from "../helpers/preflight.ts";
import { setupPermSandbox } from "../helpers/perm-sandbox.ts";
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
  await syncIfPassed(testInfo, "15-multi-pending");
});

// FIXME(2026-05-23): broken since commit 228d3de (oidc-provider subprocess
// replaces hand-rolled mock). The oidc-provider /authorize chain redirects
// through /interaction/{uid} for consent before /auth/callback, but
// loginAndConnect (helpers/pwa-client.ts) only follows the original 3-hop
// chain. The second loginAndConnect call in this scenario (out-of-band
// device) hits the new path. Tracking in docs/TODO.md. Until then, skip.
test.skip("multi-pending: queue advance + already-handled toast", async ({ page }, testInfo) => {
  test.setTimeout(360_000);

  const daemon_id = `multi-${Date.now()}`;
  // Three sandboxes — each Claude prompt has a unique target file.
  const sandboxA = setupPermSandbox("multi-a", 1);
  const sandboxB = setupPermSandbox("multi-b", 1);
  const sandboxC = setupPermSandbox("multi-c", 1);

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
    scenarioSlug: "15-multi-pending",
    projectName: testInfo.project.name,
  });

  const claudes: ClaudeTmuxHandle[] = [];
  let outOfBand: Awaited<ReturnType<typeof loginAndConnect>> | undefined;

  try {
    // Out-of-band WS-only "device": connect early so it observes every
    // permission_request frame as the daemon broadcasts them. (Snapshots do
    // not include pending permissions — see hub/router.ts onPwaSubscribe —
    // so a late connect would miss requests that arrived before it.)
    outOfBand = await loginAndConnect({
      hub_http: "http://localhost:7745",
      hub_ws: "ws://localhost:7745",
    });

    await session.page.getByTestId("home-screen").waitFor({ timeout: 30_000 });
    await session.page.getByTestId(`machine-card-${daemon_id}`).waitFor({ timeout: 30_000 });

    // Boot Claude A.
    const a = await startClaudeTmux({
      cwd: sandboxA.dir,
      prompt: `Use the Bash tool to run: rm ${sandboxA.files[0]}`,
      sessionName: `ccr-multi-a-${daemon_id}`,
      socketPath: handle.socket_path,
      mcpConfigPath: `${handle.state_dir}/cc-remote-mcp-a.json`,
      pluginEntryPath: pluginEntry,
      bootTimeoutMs: 90_000,
    });
    claudes.push(a);

    // Boot Claude B (concurrent permission). Both run against the same
    // daemon socket; the daemon multiplexes the requests to the PWA.
    const b = await startClaudeTmux({
      cwd: sandboxB.dir,
      prompt: `Use the Bash tool to run: rm ${sandboxB.files[0]}`,
      sessionName: `ccr-multi-b-${daemon_id}`,
      socketPath: handle.socket_path,
      mcpConfigPath: `${handle.state_dir}/cc-remote-mcp-b.json`,
      pluginEntryPath: pluginEntry,
      bootTimeoutMs: 90_000,
    });
    claudes.push(b);

    await sc.step("home-with-two-pending", async () => {
      await expect(
        session.page.getByTestId("permission-mini").getByText(/2 approvals waiting/),
      ).toBeVisible({ timeout: 120_000 });
    });

    await sc.step("surface-shows-1-of-2", async () => {
      await session.page.getByRole("button", { name: "Review" }).first().click();
      await session.page.getByTestId("permission-surface").waitFor({ timeout: 5_000 });
      await expect(session.page.getByTestId("permission-queue")).toHaveText(/1 of 2 pending/, { timeout: 5_000 });
    });

    await sc.step("advance-after-allow", async () => {
      await session.page.getByRole("button", { name: /Allow/ }).click();
      // After the allow, sendPermissionReply optimistically removes the
      // active request from pendingPermissions and useEffect picks the new
      // head. With only one remaining, queueSize === 1 hides the queue text
      // entirely (the surface gates it on `queueSize > 1`). Wait for that
      // transition: queue line disappears OR (rare race) shows 1 of 1.
      const surface = session.page.getByTestId("permission-surface");
      const queue = session.page.getByTestId("permission-queue");
      // Surface must remain open across the transition.
      await expect(surface).toHaveCount(1, { timeout: 5_000 });
      // queue line gone (queueSize collapsed to 1) — primary expected end state.
      await expect(queue).toHaveCount(0, { timeout: 30_000 });
    });

    // While B is the active request in the open surface, boot Claude C to add
    // a third pending. Then have a separate WS-only "device" approve B; that
    // resolution arrives in the browser and triggers the handled-notice plus
    // queue advance to C.
    const c = await startClaudeTmux({
      cwd: sandboxC.dir,
      prompt: `Use the Bash tool to run: rm ${sandboxC.files[0]}`,
      sessionName: `ccr-multi-c-${daemon_id}`,
      socketPath: handle.socket_path,
      mcpConfigPath: `${handle.state_dir}/cc-remote-mcp-c.json`,
      pluginEntryPath: pluginEntry,
      bootTimeoutMs: 90_000,
    });
    claudes.push(c);

    await sc.step("already-handled-toast", async () => {
      // Wait until the surface knows about 2 pendings (B currently active + C
      // newly pending). The queue line shows "1 of 2 pending" again.
      await expect(session.page.getByTestId("permission-queue")).toHaveText(/1 of 2 pending/, {
        timeout: 120_000,
      });

      // Identify the active request in the surface by reading the session_id
      // shown in the surface header (format: `${session_id} · ${hostname}`).
      // The first matching permission_request in outOfBand.inbox is the one
      // to approve out-of-band.
      const surfaceSubtitle = await session.page
        .getByTestId("permission-surface")
        .locator("p.text-muted-foreground")
        .first()
        .textContent();
      const activeSessionId = (surfaceSubtitle ?? "").split("·")[0]!.trim();

      // outOfBand has been listening since before any Claude booted, so its
      // inbox already contains every permission_request frame.
      const obInbox = outOfBand!.inbox;
      const activeReq = obInbox.find(
        (f) =>
          f.type === "permission_request" &&
          (f as any).daemon_id === daemon_id &&
          (f as any).session_id === activeSessionId,
      ) as { type: string; daemon_id: string; session_id: string; request_id: string; tool: string; args_summary: string; expires_at: number } | undefined;
      if (!activeReq) {
        throw new Error(
          `out-of-band inbox missing active permission_request for session ${activeSessionId}; ` +
          `inbox types: ${obInbox.map((f) => f.type).join(",")}`,
        );
      }
      // Approve out-of-band — the hub forwards permission_resolved to all
      // subscribed PWA contexts (including our browser).
      outOfBand!.approve(activeReq as any);

      // The browser observes the resolution: handled-notice fires (queue still
      // has C), surface advances, toast appears.
      await expect(session.page.getByText("Already handled on another device.")).toBeVisible({
        timeout: 10_000,
      });
      // Surface still open, now showing C alone (queueSize === 1 hides the
      // queue line).
      await expect(session.page.getByTestId("permission-surface")).toHaveCount(1);
    });

    await sc.step("surface-closes-when-empty", async () => {
      await session.page.getByRole("button", { name: /Allow/ }).click();
      await expect(session.page.getByTestId("permission-surface")).toHaveCount(0, { timeout: 30_000 });
      await expect(session.page.getByTestId("permission-mini")).toHaveCount(0, { timeout: 30_000 });
    });
  } finally {
    outOfBand?.close();
    for (const c of claudes) {
      try { c.stop(); } catch { /* best-effort */ }
    }
    await session.close();
    await handle.cleanup();
    sandboxA.cleanup();
    sandboxB.cleanup();
    sandboxC.cleanup();
  }
});
