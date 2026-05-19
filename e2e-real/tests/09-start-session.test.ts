// Scenario 09 — daemon allow_start: true, spawn_command runs claude → second
// session surfaces.
//
// The plan uses `-p "say started"` for the spawn — which means the spawned
// claude is non-interactive (-p). The plugin still loads via --mcp-config and
// registers a session. We assert that a NEW session_open arrives at the PWA.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { upCompose, downCompose } from "../helpers/compose.ts";
import { loginAndConnect } from "../helpers/pwa-client.ts";
import { pairAndStartDaemon } from "../helpers/scenario.ts";
import { preflightOrThrow } from "../helpers/preflight.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const pluginEntry = resolve(repoRoot, "packages", "plugin", "src", "index.ts");

beforeAll(async () => {
  preflightOrThrow();
  await upCompose();
}, 300_000);
afterAll(async () => { await downCompose(); }, 60_000);

test("start_session: PWA → daemon spawns claude → new session_open", async () => {
  const daemon_id = `start-${Date.now()}`;
  const cwd = mkdtempSync(join(tmpdir(), "ccr-start-"));

  // Pre-write the MCP config that the spawn_command will reference.
  // Daemon hasn't started yet, so we don't know the daemon socket path.
  // Pattern: pair → mkStateDir → write mcp config → start daemon. We need the
  // socket path BEFORE the daemon starts. Daemon socket path is
  // `<state_dir>/daemon.sock` — predictable.
  // Using helpers/daemon's mkStateDir directly:
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

  // Compose the spawn_command. ANTHROPIC auth is supplied via env passed to
  // the daemon; the daemon's tmux child inherits that env.
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

  const pwa = await loginAndConnect({ hub_http: "http://localhost:7745", hub_ws: "ws://localhost:7745" });

  const tmuxName = `ccr-start-spawn-${daemon_id}`;
  try {
    pwa.send({ type: "start_session", daemon_id, cwd, name: tmuxName });

    const opened = await pwa.waitFor((f) => {
      if (f.type === "session_open" && f.daemon_id === daemon_id) return f;
      return false;
    }, 60_000, "session_open from spawned claude");
    expect(opened).toBeTruthy();
  } finally {
    pwa.close();
    // Clean up the spawned tmux session.
    try {
      const { killSession } = await import("../helpers/tmux.ts");
      killSession(tmuxName);
    } catch {}
    await daemon.stop();
    rmStateDir(state_dir);
    rmSync(cwd, { recursive: true, force: true });
  }
}, 240_000);
