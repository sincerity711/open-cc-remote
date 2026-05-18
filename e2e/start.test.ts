import { test, expect } from "bun:test";
import { spawn, type ChildProcess, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { PwaToHub } from "@cc-remote/proto";

const ROOT = resolve(import.meta.dir, "..");
const HUB_PORT = 48445;

function tmuxAvailable(): boolean {
  return spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
}

async function waitFor<T>(pred: () => T | null, timeoutMs: number, label: string): Promise<T> {
  const start = Date.now();
  while (true) {
    const r = pred();
    if (r) return r;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

test.skipIf(!tmuxAvailable())("start_session writes sentinel via spawn_command", async () => {
  const root = mkdtempSync(join(tmpdir(), "ccr-st-"));
  const stateDir = join(root, "daemon-state");
  const sentinel = join(root, "sentinel.txt");
  const sessionCwd = root; // matches the allowed prefix
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "config.json"), JSON.stringify({
    daemon_id: "start-daemon",
    hub_url: `ws://localhost:${HUB_PORT}`,
    allow_start: true,
    allowed_cwd_prefix: [root],
    spawn_command: `sh -c 'printf hi > ${sentinel}'`,
  }));

  const procs: ChildProcess[] = [];
  const cleanup = () => {
    for (const p of procs.reverse()) try { p.kill("SIGTERM"); } catch {}
    rmSync(root, { recursive: true, force: true });
  };

  try {
    const hub = spawn("bun", ["run", join(ROOT, "packages/hub/src/index.ts")], {
      env: {
        ...process.env, HUB_PORT: String(HUB_PORT), HUB_DISABLE_AUTH: "1",
        HUB_DB_PATH: join(root, "hub.sqlite"), HUB_JWT_SECRET: "s",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    procs.push(hub);
    let hubStderr = "";
    hub.stderr?.on("data", (b: Buffer) => { hubStderr += b.toString(); });
    await new Promise((r) => setTimeout(r, 300));

    const daemon = spawn("bun", ["run", join(ROOT, "packages/daemon/src/index.ts")], {
      env: { ...process.env, CC_REMOTE_STATE_DIR: stateDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    procs.push(daemon);
    let daemonStderr = "";
    let daemonStdout = "";
    daemon.stderr?.on("data", (b: Buffer) => { daemonStderr += b.toString(); });
    daemon.stdout?.on("data", (b: Buffer) => { daemonStdout += b.toString(); });

    // Wait until daemon is ready (stdout prints "ready")
    await waitFor(() => daemonStdout.includes("ready") ? true : null, 5000, `daemon ready`);

    // Connect PWA WSS, subscribe (we just need it to know the daemon's there).
    const ws = new WebSocket(`ws://localhost:${HUB_PORT}/ws/pwa`);
    await new Promise<void>((res, rej) => {
      ws.addEventListener("open", () => res(), { once: true });
      ws.addEventListener("error", () => rej(new Error("ws error")), { once: true });
    });
    ws.send(JSON.stringify({ type: "subscribe" } satisfies PwaToHub));

    // Send start_session.
    const tmuxName = `ccr-test-${Date.now()}`;
    const msg: PwaToHub = {
      type: "start_session",
      daemon_id: "start-daemon",
      cwd: sessionCwd,
      name: tmuxName,
    };
    ws.send(JSON.stringify(msg));

    // Wait for sentinel.
    await waitFor(() => existsSync(sentinel) ? true : null, 5000, `sentinel file (daemon stderr: ${daemonStderr.slice(-300)})`);

    expect(existsSync(sentinel)).toBe(true);

    // Defensively clean up the tmux session if it lingers.
    try { spawnSync("tmux", ["kill-session", "-t", tmuxName], { stdio: "ignore" }); } catch {}

    ws.close();
  } finally {
    cleanup();
  }
}, 30_000);

test.skipIf(!tmuxAvailable())("start_session is rejected when allow_start is false", async () => {
  const root = mkdtempSync(join(tmpdir(), "ccr-st2-"));
  const stateDir = join(root, "daemon-state");
  const sentinel = join(root, "sentinel.txt");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "config.json"), JSON.stringify({
    daemon_id: "no-start-daemon",
    hub_url: `ws://localhost:${HUB_PORT + 1}`,
    // allow_start omitted → defaults false
    allowed_cwd_prefix: [root],
    spawn_command: `sh -c 'printf hi > ${sentinel}'`,
  }));

  const procs: ChildProcess[] = [];
  const cleanup = () => {
    for (const p of procs.reverse()) try { p.kill("SIGTERM"); } catch {}
    rmSync(root, { recursive: true, force: true });
  };

  try {
    const hub = spawn("bun", ["run", join(ROOT, "packages/hub/src/index.ts")], {
      env: {
        ...process.env, HUB_PORT: String(HUB_PORT + 1), HUB_DISABLE_AUTH: "1",
        HUB_DB_PATH: join(root, "hub.sqlite"), HUB_JWT_SECRET: "s",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    procs.push(hub);
    await new Promise((r) => setTimeout(r, 300));

    const daemon = spawn("bun", ["run", join(ROOT, "packages/daemon/src/index.ts")], {
      env: { ...process.env, CC_REMOTE_STATE_DIR: stateDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    procs.push(daemon);
    let daemonStderr = "";
    let daemonStdout2 = "";
    daemon.stderr?.on("data", (b: Buffer) => { daemonStderr += b.toString(); });
    daemon.stdout?.on("data", (b: Buffer) => { daemonStdout2 += b.toString(); });
    await waitFor(() => daemonStdout2.includes("ready") ? true : null, 5000, `daemon ready`);

    const ws = new WebSocket(`ws://localhost:${HUB_PORT + 1}/ws/pwa`);
    await new Promise<void>((res) => {
      ws.addEventListener("open", () => res(), { once: true });
    });
    ws.send(JSON.stringify({ type: "subscribe" } satisfies PwaToHub));
    ws.send(JSON.stringify({
      type: "start_session",
      daemon_id: "no-start-daemon",
      cwd: root,
    } satisfies PwaToHub));

    await new Promise((r) => setTimeout(r, 1500));
    expect(existsSync(sentinel)).toBe(false);
    expect(daemonStderr).toContain("start_session ignored");

    ws.close();
  } finally {
    cleanup();
  }
}, 30_000);
