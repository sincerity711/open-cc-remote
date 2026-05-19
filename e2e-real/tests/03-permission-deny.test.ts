// Scenario 03 — same setup as 02 but PWA denies the permission. The plugin
// returns deny to Claude, and the PWA receives a permission_resolved with
// decision: "deny".

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

test("permission deny: PWA denies → permission_resolved with decision deny", async () => {
  const daemon_id = `permdeny-${Date.now()}`;
  const sandbox = setupPermSandbox("deny", 1);

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
      sessionName: `ccr-permdeny-${daemon_id}`,
      socketPath: handle.socket_path,
      mcpConfigPath: `${handle.state_dir}/cc-remote-mcp.json`,
      pluginEntryPath: pluginEntry,
    });

    const req = await pwa.waitFor((f) => {
      if (f.type === "permission_request" && f.daemon_id === daemon_id) return f;
      return false;
    }, 60_000, "permission_request");
    expect((req as any).request_id).toMatch(/^[a-km-z]{5}$/);
    pwa.deny(req as any);

    const resolved = await pwa.waitFor((f) => {
      if (f.type === "permission_resolved" && (f as any).request_id === (req as any).request_id) return f;
      return false;
    }, 15_000, "permission_resolved");
    expect((resolved as any).decision).toBe("deny");
  } finally {
    pwa.close();
    claude?.stop();
    await handle.cleanup();
    sandbox.cleanup();
  }
}, 240_000);
