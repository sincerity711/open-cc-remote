// Scenario 09 — daemon allow_start: true, spawn_command runs claude → second
// session surfaces. Browser-driven Playwright variant per P6 plan task 10.
//
// The DaemonCard exposes a "/path/to/project" text input + a Start session
// icon button. Submitting the form triggers a `start_session` frame; the
// daemon executes spawn_command in the supplied cwd, claude registers via
// the MCP plugin, and a NEW session_open arrives at the PWA.

import { test, expect } from "@playwright/test";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { upCompose, downCompose } from "../helpers/compose.ts";
import { openPwa } from "../helpers/pwa-browser.ts";
import { startPreview, type PreviewHandle } from "../helpers/preview-server.ts";
import { makeScenarioContext } from "../helpers/scenario.ts";
import { preflightOrThrow } from "../helpers/preflight.ts";

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

test("start session: cwd input → Start button → row appears", async ({ page }, testInfo) => {
  test.setTimeout(300_000);

  const daemon_id = `start-${Date.now()}`;
  const cwd = mkdtempSync(join(tmpdir(), "ccr-start-"));

  // Pair → mkStateDir → write mcp config → start daemon. Daemon socket path
  // is `<state_dir>/daemon.sock` — predictable.
  const { mkStateDir, pairDaemon, startDaemon, rmStateDir } = await import("../helpers/daemon.ts");
  const { issuePairingCode } = await import("../helpers/admin.ts");

  const code = issuePairingCode(daemon_id);
  const state_dir = mkStateDir(daemon_id);
  pairDaemon({ state_dir, hub_url: "http://localhost:7745", code, daemon_id });

  const mcpPath = `${state_dir}/cc-remote-mcp.json`;
  const socketPath = `${state_dir}/daemon.sock`;
  const mcpConfig = {
    mcpServers: {
      "cc-remote": {
        command: "bun",
        args: ["run", pluginEntry],
        env: { CC_REMOTE_SOCKET: socketPath },
      },
    },
  };
  writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2));

  // Compose the spawn_command. ANTHROPIC auth is supplied via env.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  const authPrefix = apiKey
    ? `ANTHROPIC_API_KEY=${apiKey}`
    : `ANTHROPIC_AUTH_TOKEN=${authToken} ANTHROPIC_BASE_URL=${baseUrl}`;
  const spawn_command = [
    authPrefix,
    "claude",
    "--mcp-config", mcpPath,
    "--dangerously-load-development-channels", "server:cc-remote",
    "--model", "claude-haiku-4-5",
    "--setting-sources", "project,local",
    "-p", "\"say started\"",
  ].join(" ");

  const daemon = await startDaemon({
    daemon_id,
    hub_url: "ws://localhost:7745",
    state_dir,
    allow_start: true,
    allowed_cwd_prefix: [tmpdir(), "/private/tmp", "/tmp"],
    spawn_command,
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
    scenarioSlug: "09-start-session",
    projectName: testInfo.project.name,
  });

  const tmuxName = `ccr-start-spawn-${daemon_id}`;
  try {
    await sc.step("home-after-login", async () => {
      await session.page.getByTestId("home-screen").waitFor({ timeout: 30_000 });
    });

    await sc.step("daemon-card-visible", async () => {
      await session.page.getByTestId(`machine-card-${daemon_id}`).waitFor({ timeout: 30_000 });
    });

    await sc.step("cwd-typed-and-start-clicked", async () => {
      // The DaemonCard inside the machine-card holds a labeled input
      // ("Working directory for <hostname>") and an icon Start button.
      const card = session.page.getByTestId(`machine-card-${daemon_id}`);
      const cwdInput = card.getByRole("textbox");
      await cwdInput.waitFor({ timeout: 5_000 });
      await cwdInput.fill(cwd);
      await card.getByRole("button", { name: "Start session" }).click();
    });

    await sc.step("session-row-appears", async () => {
      // After spawn, claude registers via MCP → session_open arrives → row
      // renders under the daemon card. Real claude boot under the test
      // runner can take a while; budget 90s.
      const sessionsList = session.page.getByTestId(`sessions-${daemon_id}`);
      await expect(sessionsList.locator(".bg-surface").first()).toBeVisible({ timeout: 120_000 });
    });
  } finally {
    // Clean up the spawned tmux session.
    try {
      const { killSession } = await import("../helpers/tmux.ts");
      killSession(tmuxName);
    } catch { /* noop */ }
    await session.close();
    await daemon.stop();
    rmStateDir(state_dir);
    rmSync(cwd, { recursive: true, force: true });
  }
});
