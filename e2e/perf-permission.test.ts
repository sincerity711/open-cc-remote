import { test, expect } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { HubToPwa, PwaToHub } from "@cc-remote/proto";
import { connectDaemon } from "../packages/plugin/src/daemon-client.ts";

const ROOT = resolve(import.meta.dir, "..");
const HUB_PORT = 48145;
const ITERATIONS = 20;
const P95_LIMIT_MS = 1000;

async function waitFor<T>(pred: () => T | null, timeoutMs: number, label: string): Promise<T> {
  const start = Date.now();
  while (true) {
    const r = pred();
    if (r) return r;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("permission round-trip P95 < 1s over 20 iterations", async () => {
  const root = mkdtempSync(join(tmpdir(), "ccr-perf-"));
  const stateDir = join(root, "daemon-state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "config.json"), JSON.stringify({
    daemon_id: "perf-daemon",
    hub_url: `ws://localhost:${HUB_PORT}`,
  }));

  const procs: ChildProcess[] = [];
  const cleanup = () => {
    for (const p of procs.reverse()) try { p.kill("SIGTERM"); } catch {}
    rmSync(root, { recursive: true, force: true });
  };

  try {
    // Hub.
    const hub = spawn("bun", ["run", join(ROOT, "packages/hub/src/index.ts")], {
      env: {
        ...process.env, HUB_PORT: String(HUB_PORT), HUB_DISABLE_AUTH: "1",
        HUB_DB_PATH: join(root, "hub.sqlite"), HUB_JWT_SECRET: "s",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    procs.push(hub);
    await new Promise((r) => setTimeout(r, 300));

    // Daemon.
    const daemon = spawn("bun", ["run", join(ROOT, "packages/daemon/src/index.ts")], {
      env: { ...process.env, CC_REMOTE_STATE_DIR: stateDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    procs.push(daemon);
    let daemonStderr = "";
    daemon.stderr?.on("data", (b: Buffer) => { daemonStderr += b.toString(); });
    await new Promise((r) => setTimeout(r, 400));

    // Connect a "plugin" via the daemon-client primitive (no real plugin process).
    const sockPath = join(stateDir, "daemon.sock");
    const client = await connectDaemon(sockPath, 5000);
    await client.send({
      type: "register",
      session: {
        session_id: "s_perf", tmux_session: null, tmux_pane: null,
        cwd: "/tmp/perf", model: "perf", pid: process.pid, started_at: Math.floor(Date.now() / 1000),
      },
    });

    // Connect PWA-style WSS, auto-reply to every permission_request.
    const ws = new WebSocket(`ws://localhost:${HUB_PORT}/ws/pwa`);
    const inbox: HubToPwa[] = [];
    const sendReply = (req: { daemon_id: string; session_id: string; request_id: string }) => {
      const msg: PwaToHub = {
        type: "permission_reply",
        daemon_id: req.daemon_id, session_id: req.session_id, request_id: req.request_id,
        decision: "allow",
      };
      ws.send(JSON.stringify(msg));
    };
    ws.addEventListener("message", (ev) => {
      try {
        const f = JSON.parse(typeof ev.data === "string" ? ev.data : "") as HubToPwa;
        inbox.push(f);
        if (f.type === "permission_request") sendReply(f);
      } catch {}
    });
    await new Promise<void>((res, rej) => {
      ws.addEventListener("open", () => res(), { once: true });
      ws.addEventListener("error", () => rej(new Error("ws error")), { once: true });
    });
    ws.send(JSON.stringify({ type: "subscribe" } satisfies PwaToHub));
    // Wait for s_perf snapshot.
    await waitFor(() => {
      for (const f of inbox) {
        if (f.type === "snapshot" && f.daemons.some((d) => d.sessions.some((s) => s.session_id === "s_perf"))) return true;
        if (f.type === "session_open" && f.session.session_id === "s_perf") return true;
      }
      return null;
    }, 3000, `s_perf to surface (daemon stderr: ${daemonStderr.slice(-300)})`);

    // Run iterations sequentially.
    const timings: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const requestId = `perf-${i}-${Date.now()}`;
      // Find resolved frame for this request_id.
      const before = inbox.length;
      const t0 = Date.now();
      client.sendOneWay({
        type: "permission_request",
        request_id: requestId,
        tool: "Bash",
        args_summary: `iter-${i}`,
        expires_at: Date.now() + 60_000,
      });
      // Wait for permission_resolved with our request_id.
      await waitFor(() => {
        for (let j = before; j < inbox.length; j++) {
          const f = inbox[j];
          if (f && f.type === "permission_resolved" && f.request_id === requestId) return f;
        }
        return null;
      }, 5000, `iter ${i} resolution (daemon stderr: ${daemonStderr.slice(-300)})`);
      const dt = Date.now() - t0;
      timings.push(dt);
    }

    timings.sort((a, b) => a - b);
    const median = timings[Math.floor(timings.length / 2)];
    const p95 = timings[Math.floor(timings.length * 0.95)];
    process.stderr.write(`perf: median=${median}ms p95=${p95}ms (${ITERATIONS} iterations)\n`);

    expect(p95).toBeLessThan(P95_LIMIT_MS);
    expect(median).toBeLessThan(P95_LIMIT_MS);

    client.close();
    ws.close();
  } finally {
    cleanup();
  }
}, 60_000);  // 60s test timeout to be safe
