// Scenario 06 — task_completed + idle_window_ms quiet → idle frame surfaces.
//
// Idle-timer semantics in the daemon (packages/daemon/src/index.ts):
// real Claude writes trailing metadata (`system`, `last-prompt`, `ai-title`,
// `permission-mode`, …) AFTER `assistant end_turn`. The daemon's idle timer
// is armed on end_turn and is only cancelled by a NEW user/assistant turn,
// not by trailing metadata — so idle fires reliably even under real Claude.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { upCompose, downCompose } from "../helpers/compose.ts";
import { startClaudeTmux } from "../helpers/claude-tmux.ts";
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

test("real Claude turn → task_completed → idle (idle_window_ms=3000)", async () => {
  const daemon_id = `idle-${Date.now()}`;
  const handle = await pairAndStartDaemon({
    daemon_id,
    hub_url: "ws://localhost:7745",
    hub_http: "http://localhost:7745",
    idle_window_ms: 3_000,
  });

  const pwa = await loginAndConnect({ hub_http: "http://localhost:7745", hub_ws: "ws://localhost:7745" });

  let claude: { stop: () => void } | undefined;
  try {
    claude = await startClaudeTmux({
      cwd: "/tmp",
      prompt: "say idle test",
      sessionName: `ccr-idle-${daemon_id}`,
      socketPath: handle.socket_path,
      mcpConfigPath: `${handle.state_dir}/cc-remote-mcp.json`,
      pluginEntryPath: pluginEntry,
    });

    await pwa.waitFor(
      (f) => f.type === "task_completed" && f.daemon_id === daemon_id ? f : false,
      90_000, "task_completed",
    );
    const idle = await pwa.waitFor(
      (f) => f.type === "idle" && f.daemon_id === daemon_id ? f : false,
      30_000, "idle",
    );
    expect(idle).toBeTruthy();
  } finally {
    pwa.close();
    claude?.stop();
    await handle.cleanup();
  }
}, 180_000);
