// Scenario 07 — 3 daemons concurrent, all surface to PWA via fake-claude.
// Explicit boundary: this scenario does NOT use real claude (the e2e-real
// boundary deliberately keeps the multi-daemon coverage cheap).

import { test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { upCompose, downCompose } from "../helpers/compose.ts";
import { loginAndConnect } from "../helpers/pwa-client.ts";
import { pairAndStartDaemon } from "../helpers/scenario.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const fakeClaude = resolve(repoRoot, "tools", "fake-claude", "fake-claude.ts");

beforeAll(async () => { await upCompose(); }, 300_000);
afterAll(async () => { await downCompose(); }, 60_000);

test("3 daemons concurrent: each surfaces to PWA", async () => {
  const ts = Date.now();
  const ids = [`md-${ts}-a`, `md-${ts}-b`, `md-${ts}-c`];
  const cwdRoot = mkdtempSync(join(tmpdir(), "ccr-md-"));

  const handles: Awaited<ReturnType<typeof pairAndStartDaemon>>[] = [];
  const fakes: ChildProcess[] = [];

  const pwa = await loginAndConnect({
    hub_http: "http://localhost:7745",
    hub_ws: "ws://localhost:7745",
  });

  try {
    for (const id of ids) {
      const h = await pairAndStartDaemon({
        daemon_id: id,
        hub_url: "ws://localhost:7745",
        hub_http: "http://localhost:7745",
      });
      handles.push(h);
    }

    for (const h of handles) {
      const fc = spawn("bun", [
        "run", fakeClaude,
        "--session-id", `s-${h.daemon_id}`,
        "--cwd", cwdRoot,
        "--socket", h.socket_path,
      ], { stdio: ["ignore", "pipe", "pipe"] });
      fakes.push(fc);
    }

    // Wait for each daemon's session to appear.
    for (const id of ids) {
      const matched = await pwa.waitFor((f) => {
        if (f.type === "session_open" && f.daemon_id === id) return f;
        if (f.type === "snapshot") {
          for (const d of f.daemons) {
            if (d.daemon_id === id && d.sessions.length > 0) return f;
          }
        }
        if (f.type === "daemon_online" && f.daemon_id === id && f.sessions.length > 0) return f;
        return false;
      }, 15_000, `daemon ${id} session`);
      expect(matched).toBeTruthy();
    }
  } finally {
    pwa.close();
    for (const fc of fakes) {
      try { fc.kill("SIGTERM"); } catch {}
    }
    for (const h of handles) {
      await h.cleanup();
    }
    rmSync(cwdRoot, { recursive: true, force: true });
  }
}, 120_000);
