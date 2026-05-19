// Scenario 01 — pair a daemon, restart it paired, run real Claude, assert PWA
// sees the session in a snapshot or session_open frame.
//
// Smoke test for the whole infrastructure: docker compose up + admin pairing
// code + cc-remote pair + real claude + tmux + plugin MCP + PWA login + WSS.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { upCompose, downCompose } from "../helpers/compose.ts";
import { issuePairingCode } from "../helpers/admin.ts";
import { startDaemon, pairDaemon, mkStateDir, rmStateDir } from "../helpers/daemon.ts";
import { startClaudeTmux } from "../helpers/claude-tmux.ts";
import { loginAndConnect } from "../helpers/pwa-client.ts";
import { preflightOrThrow } from "../helpers/preflight.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const pluginEntry = resolve(repoRoot, "packages", "plugin", "src", "index.ts");

beforeAll(async () => {
  preflightOrThrow();
  await upCompose();
}, 300_000);

afterAll(async () => {
  await downCompose();
}, 60_000);

test("real Claude session pairs and shows up in PWA snapshot", async () => {
  const daemon_id = `pair-snap-${Date.now()}`;
  const sessionName = `ccr-pair-${daemon_id}`;

  // 1. Issue pairing code via hub admin.
  const code = issuePairingCode(daemon_id);
  expect(code.length).toBeGreaterThan(0);

  // 2. Pair into a fresh state dir (writes state.json + keystore).
  const state_dir = mkStateDir(daemon_id);
  pairDaemon({ state_dir, hub_url: "http://localhost:7745", code, daemon_id });

  // 3. Start the paired daemon.
  const daemon = await startDaemon({
    daemon_id,
    hub_url: "ws://localhost:7745",
    state_dir,
  });

  // 4. PWA login + connect.
  const pwa = await loginAndConnect({
    hub_http: "http://localhost:7745",
    hub_ws: "ws://localhost:7745",
  });

  let claude: { stop: () => void } | undefined;
  try {
    // 5. Launch real claude under tmux. Plugin connects to daemon via Unix socket.
    claude = await startClaudeTmux({
      cwd: "/tmp",
      prompt: "say hi",
      sessionName,
      socketPath: daemon.socket_path,
      mcpConfigPath: `${daemon.state_dir}/cc-remote-mcp.json`,
      pluginEntryPath: pluginEntry,
    });

    // 6. Wait for the session to surface to the PWA.
    const matched = await pwa.waitFor((f) => {
      if (f.type === "session_open" && f.daemon_id === daemon_id) return f;
      if (f.type === "snapshot") {
        for (const d of f.daemons) {
          if (d.daemon_id === daemon_id && d.sessions.length > 0) return f;
        }
      }
      if (f.type === "daemon_online" && f.daemon_id === daemon_id && f.sessions.length > 0) return f;
      return false;
    }, 60_000, "session_open or snapshot containing this daemon's session");
    expect(matched).toBeTruthy();
  } finally {
    pwa.close();
    claude?.stop();
    await daemon.stop();
    rmStateDir(state_dir);
  }
}, 180_000);
