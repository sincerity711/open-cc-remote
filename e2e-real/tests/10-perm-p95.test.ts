// Scenario 10 — 5 sequential Bash permission prompts; assert P95 < 1000ms.
//
// Single tmux session with sequential `sendKeys` between approvals. The
// alternative (5 separate sessions) is documented in spec §9 #2 but rejected
// here for boot-cost reasons.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { upCompose, downCompose } from "../helpers/compose.ts";
import { startClaudeTmux } from "../helpers/claude-tmux.ts";
import { loginAndConnect } from "../helpers/pwa-client.ts";
import { pairAndStartDaemon } from "../helpers/scenario.ts";
import { preflightOrThrow } from "../helpers/preflight.ts";
import { setupPermSandbox } from "../helpers/perm-sandbox.ts";
import * as tmux from "../helpers/tmux.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const pluginEntry = resolve(repoRoot, "packages", "plugin", "src", "index.ts");

beforeAll(async () => {
  preflightOrThrow();
  await upCompose();
}, 300_000);
afterAll(async () => { await downCompose(); }, 60_000);

test("perm p95: 5 sequential approvals in one session, P95 < 1s", async () => {
  const N = 5;
  const daemon_id = `permp95-${Date.now()}`;
  const sandbox = setupPermSandbox("p95", N);

  const handle = await pairAndStartDaemon({
    daemon_id,
    hub_url: "ws://localhost:7745",
    hub_http: "http://localhost:7745",
  });

  const pwa = await loginAndConnect({ hub_http: "http://localhost:7745", hub_ws: "ws://localhost:7745" });
  const sessionName = `ccr-permp95-${daemon_id}`;

  let claude: { stop: () => void } | undefined;
  try {
    claude = await startClaudeTmux({
      cwd: sandbox.dir,
      // First prompt is the first deletion — boot + first request together.
      prompt: `Use the Bash tool to run: rm ${sandbox.files[0]}`,
      sessionName,
      socketPath: handle.socket_path,
      mcpConfigPath: `${handle.state_dir}/cc-remote-mcp.json`,
      pluginEntryPath: pluginEntry,
    });

    const latencies: number[] = [];
    const seen = new Set<string>();

    for (let i = 0; i < N; i++) {
      // For prompts 1..N-1, wait a moment for claude to finish rendering its
      // previous turn before the next send-keys lands in the input box.
      if (i > 0) {
        await new Promise((r) => setTimeout(r, 2000));
        tmux.sendKeys(sessionName, `Use the Bash tool to run: rm ${sandbox.files[i]}`, false);
        await new Promise((r) => setTimeout(r, 500));
        tmux.sendEnter(sessionName);
      }

      const req = await pwa.waitFor((f) => {
        if (f.type === "permission_request" && f.daemon_id === daemon_id && !seen.has((f as any).request_id)) return f;
        return false;
      }, 90_000, `permission_request #${i + 1}`);
      seen.add((req as any).request_id);
      // Latency timer starts when PWA receives the request (excludes Claude's
      // tool-call decision time); ends when PWA receives permission_resolved
      // (the hub-side ack of the round-trip).
      const requestArrivedAt = Date.now();
      pwa.approve(req as any);
      await pwa.waitFor((f) => {
        if (f.type === "permission_resolved" && (f as any).request_id === (req as any).request_id) return f;
        return false;
      }, 15_000, `permission_resolved #${i + 1}`);
      latencies.push(Date.now() - requestArrivedAt);
    }

    latencies.sort((a, b) => a - b);
    const p95Index = Math.max(0, Math.ceil(latencies.length * 0.95) - 1);
    const p95 = latencies[p95Index]!;
    process.stderr.write(`[scenario 10] latencies (ms): ${latencies.join(", ")}; P95=${p95}ms\n`);
    expect(p95).toBeLessThan(1000);
  } finally {
    pwa.close();
    claude?.stop();
    await handle.cleanup();
    sandbox.cleanup();
  }
}, 600_000);
