// Scenario 04 — session runs → PWA request_history → history_chunk with events.

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

test("session runs → PWA request_history returns events ordered", async () => {
  const daemon_id = `hist-${Date.now()}`;
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
      prompt: "list three fruits, one per line",
      sessionName: `ccr-hist-${daemon_id}`,
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
    }, 60_000, "session_open or snapshot with sessions");
    const session_id = (opened as any).session.session_id as string;

    // Wait for task_completed so JSONL has been flushed.
    await pwa.waitFor((f) => f.type === "task_completed" && f.daemon_id === daemon_id ? f : false,
      90_000, "task_completed");

    // Request history.
    pwa.send({
      type: "request_history",
      daemon_id,
      session_id,
      request_id: "rh-test",
      before_offset: Number.MAX_SAFE_INTEGER,
      limit: 100,
    });
    const chunk = await pwa.waitFor((f) => f.type === "history_chunk" && (f as any).request_id === "rh-test" ? f : false,
      15_000, "history_chunk");
    expect((chunk as any).events.length).toBeGreaterThan(0);
  } finally {
    pwa.close();
    claude?.stop();
    await handle.cleanup();
  }
}, 240_000);
