// Scenario 05 — task_completed frame surfaces to PWA when claude completes a
// turn. Real claude under tmux; text-only prompt to avoid permission noise.

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

test("real Claude turn → task_completed frame to PWA", async () => {
  const daemon_id = `tc-${Date.now()}`;
  const handle = await pairAndStartDaemon({
    daemon_id,
    hub_url: "ws://localhost:7745",
    hub_http: "http://localhost:7745",
  });

  const pwa = await loginAndConnect({ hub_http: "http://localhost:7745", hub_ws: "ws://localhost:7745" });

  let claude: { stop: () => void } | undefined;
  try {
    claude = await startClaudeTmux({
      cwd: "/tmp",
      prompt: "say done",
      sessionName: `ccr-tc-${daemon_id}`,
      socketPath: handle.socket_path,
      mcpConfigPath: `${handle.state_dir}/cc-remote-mcp.json`,
      pluginEntryPath: pluginEntry,
    });

    const matched = await pwa.waitFor(
      (f) => f.type === "task_completed" && f.daemon_id === daemon_id ? f : false,
      90_000, "task_completed",
    );
    expect(matched).toBeTruthy();
  } finally {
    pwa.close();
    claude?.stop();
    await handle.cleanup();
  }
}, 180_000);
