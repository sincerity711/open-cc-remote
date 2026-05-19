import { test, expect } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { HubToPwa, PwaToHub } from "@cc-remote/proto";

const ROOT = resolve(import.meta.dir, "..");
const HUB_PORT = 47745;

async function waitFor<T>(pred: () => T | null, timeoutMs: number, label: string): Promise<T> {
  const start = Date.now();
  while (true) {
    const r = pred();
    if (r) return r;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function awaitOpen(ws: WebSocket): Promise<void> {
  await new Promise<void>((res, rej) => {
    ws.addEventListener("open", () => res(), { once: true });
    ws.addEventListener("error", () => rej(new Error("ws error")), { once: true });
  });
}

test("plugin → daemon → hub → PWA snapshot loop", async () => {
  // Per-test state directory.
  const stateDir = mkdtempSync(join(tmpdir(), "ccr-e2e-"));
  writeFileSync(join(stateDir, "config.json"), JSON.stringify({
    daemon_id: "test-daemon",
    hub_url: `ws://localhost:${HUB_PORT}`,
  }));

  const procs: ChildProcess[] = [];
  const cleanup = () => {
    for (const p of procs.reverse()) try { p.kill("SIGTERM"); } catch {}
    rmSync(stateDir, { recursive: true, force: true });
  };

  try {
    // Start hub.
    const hub = spawn("bun", ["run", join(ROOT, "packages/hub/src/index.ts")], {
      env: {
        ...process.env,
        HUB_PORT: String(HUB_PORT),
        HUB_DISABLE_AUTH: "1",
        HUB_DB_PATH: join(stateDir, "hub.sqlite"),
        HUB_JWT_SECRET: "test-secret",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    procs.push(hub);
    await waitFor(() => hub.stdout?.readable ? true : null, 2000, "hub stdout ready");
    await new Promise((r) => setTimeout(r, 200)); // give it a tick to bind

    // Start daemon.
    const daemon = spawn("bun", ["run", join(ROOT, "packages/daemon/src/index.ts")], {
      env: { ...process.env, CC_REMOTE_STATE_DIR: stateDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    procs.push(daemon);
    await waitFor(() => daemon.stdout?.readable ? true : null, 2000, "daemon stdout ready");
    await new Promise((r) => setTimeout(r, 300));

    // Start fake-claude (which spawns plugin).
    const sockPath = join(stateDir, "daemon.sock");
    const fc = spawn("bun", [
      join(ROOT, "tools/fake-claude/fake-claude.ts"),
      "--session-id", "s_e2e",
      "--cwd", "/tmp/e2e-cwd",
      "--socket", sockPath,
    ], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    procs.push(fc);

    // Connect as PWA, subscribe, await snapshot containing s_e2e.
    const ws = new WebSocket(`ws://localhost:${HUB_PORT}/ws/pwa`);
    const inbox: HubToPwa[] = [];
    ws.addEventListener("message", (ev) => {
      try { inbox.push(JSON.parse(typeof ev.data === "string" ? ev.data : "") as HubToPwa); } catch {}
    });
    await awaitOpen(ws);
    const sub: PwaToHub = { type: "subscribe" };
    ws.send(JSON.stringify(sub));

    const found = await waitFor(() => {
      for (const f of inbox) {
        if (f.type === "snapshot") {
          for (const d of f.daemons) {
            if (d.daemon_id === "test-daemon" && d.sessions.some((s) => s.session_id === "s_e2e")) {
              return d;
            }
          }
        }
        if (f.type === "session_open" && f.daemon_id === "test-daemon" && f.session.session_id === "s_e2e") {
          return f.session;
        }
      }
      return null;
    }, 5000, "session s_e2e to appear");

    expect(found).toBeTruthy();
    ws.close();

    // Tear down fake-claude → daemon should send session_close.
    fc.kill("SIGTERM");
    await waitFor(() => fc.exitCode !== null ? true : null, 8000, "fake-claude exit");
  } finally {
    cleanup();
  }
}, 30_000);
