// Scenario 08 — daemon allow_kill: true; PWA kill_session → claude exits +
// session_close.

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

test("kill_session: PWA → daemon → claude exits + session_close", async () => {
  const daemon_id = `kill-${Date.now()}`;
  const handle = await pairAndStartDaemon({
    daemon_id,
    hub_url: "ws://localhost:7745",
    hub_http: "http://localhost:7745",
    allow_kill: true,
  });

  const pwa = await loginAndConnect({ hub_http: "http://localhost:7745", hub_ws: "ws://localhost:7745" });

  let claude: ReturnType<typeof startClaudeTmux> extends Promise<infer R> ? R | undefined : never;
  try {
    claude = await startClaudeTmux({
      cwd: "/tmp",
      prompt: "count from 1 to 100, one per line, slowly",
      sessionName: `ccr-kill-${daemon_id}`,
      socketPath: handle.socket_path,
      mcpConfigPath: `${handle.state_dir}/cc-remote-mcp.json`,
      pluginEntryPath: pluginEntry,
    });

    // Capture session_id from session_open or snapshot.
    const opened = await pwa.waitFor((f) => {
      if (f.type === "session_open" && f.daemon_id === daemon_id) return f;
      if (f.type === "snapshot") {
        for (const d of f.daemons) {
          if (d.daemon_id === daemon_id && d.sessions.length > 0) {
            return { type: "session_open" as const, daemon_id: d.daemon_id, session: d.sessions[0]! };
          }
        }
      }
      return false;
    }, 60_000, "session_open");
    const session_id = (opened as any).session.session_id as string;

    pwa.send({ type: "kill_session", daemon_id, session_id });

    const closed = await pwa.waitFor((f) => {
      if (f.type === "session_close" && f.daemon_id === daemon_id && (f as any).session_id === session_id) return f;
      return false;
    }, 30_000, "session_close");
    expect(closed).toBeTruthy();
  } finally {
    pwa.close();
    claude?.stop();
    await handle.cleanup();
  }
}, 240_000);
