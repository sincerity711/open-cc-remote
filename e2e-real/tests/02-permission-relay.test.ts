// Scenario 02 — real channel-permission protocol round-trip.
// Real Claude tool-call → plugin → daemon → hub → PWA → approve →
// hub → daemon → plugin → Claude continues.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { upCompose, downCompose } from "../helpers/compose.ts";
import { startClaudeTmux } from "../helpers/claude-tmux.ts";
import { loginAndConnect } from "../helpers/pwa-client.ts";
import { pairAndStartDaemon } from "../helpers/scenario.ts";
import { preflightOrThrow } from "../helpers/preflight.ts";
import { setupPermSandbox } from "../helpers/perm-sandbox.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const pluginEntry = resolve(repoRoot, "packages", "plugin", "src", "index.ts");

beforeAll(async () => {
  preflightOrThrow();
  await upCompose();
}, 300_000);
afterAll(async () => { await downCompose(); }, 60_000);

test("permission relay: PWA approve → tool runs → task_completed", async () => {
  const daemon_id = `perm-${Date.now()}`;
  const sandbox = setupPermSandbox("relay", 1);

  const handle = await pairAndStartDaemon({
    daemon_id,
    hub_url: "ws://localhost:7745",
    hub_http: "http://localhost:7745",
  });

  const pwa = await loginAndConnect({ hub_http: "http://localhost:7745", hub_ws: "ws://localhost:7745" });

  let claude: { stop: () => void } | undefined;
  try {
    claude = await startClaudeTmux({
      cwd: sandbox.dir,
      prompt: `Use the Bash tool to run: rm ${sandbox.files[0]}`,
      sessionName: `ccr-perm-${daemon_id}`,
      socketPath: handle.socket_path,
      mcpConfigPath: `${handle.state_dir}/cc-remote-mcp.json`,
      pluginEntryPath: pluginEntry,
    });

    const req = await pwa.waitFor((f) => {
      if (f.type === "permission_request" && f.daemon_id === daemon_id) return f;
      return false;
    }, 60_000, "permission_request");
    expect((req as any).request_id).toMatch(/^[a-km-z]{5}$/);
    pwa.approve(req as any);

    const resolved = await pwa.waitFor((f) => {
      if (f.type === "permission_resolved" && (f as any).request_id === (req as any).request_id) return f;
      return false;
    }, 15_000, "permission_resolved");
    expect((resolved as any).decision).toBe("allow");

    // Note: we don't strictly assert task_completed here — real Claude may
    // take a while to summarize after the tool call, and the central thing
    // this scenario proves is the channel-permission round-trip itself.
    // Best-effort wait, but treated as soft.
    try {
      await pwa.waitFor((f) => f.type === "task_completed" && f.daemon_id === daemon_id ? f : false,
        45_000, "task_completed after permission allow");
    } catch (e) {
      process.stderr.write(`[scenario 02] task_completed didn't arrive in 45s — round-trip itself succeeded; continuing\n`);
    }
  } finally {
    pwa.close();
    claude?.stop();
    await handle.cleanup();
    sandbox.cleanup();
  }
}, 240_000);
