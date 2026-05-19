// Scenario 06 — task_completed + idle_window_ms quiet → idle frame surfaces.
//
// KNOWN ISSUE (2026-05-20): real Claude writes `system`, `last-prompt`,
// `ai-title`, `permission-mode` JSONL entries AFTER `assistant end_turn`.
// The daemon's idle-timer logic (packages/daemon/src/index.ts:192-214) only
// arms the timer on end_turn and *clears it on every subsequent line*
// without re-arming. So idle never fires when real Claude is the source.
// This is a product-level gap that should be addressed in the daemon (e.g.
// re-arm idle timer on each line, or only watch for terminal markers).
// For now, this scenario is expected to fail until that fix lands.

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
