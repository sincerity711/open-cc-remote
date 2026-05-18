import { test, expect } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { HubToPwa, PwaToHub } from "@cc-remote/proto";

const ROOT = resolve(import.meta.dir, "..");
const HUB_PORT = 48345;

async function waitFor<T>(pred: () => T | null, timeoutMs: number, label: string): Promise<T> {
  const start = Date.now();
  while (true) {
    const r = pred();
    if (r) return r;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

test("PWA kill_session terminates the plugin and triggers session_close", async () => {
  const root = mkdtempSync(join(tmpdir(), "ccr-k-"));
  const stateDir = join(root, "daemon-state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "config.json"), JSON.stringify({
    daemon_id: "kill-daemon",
    hub_url: `ws://localhost:${HUB_PORT}`,
    allow_kill: true,
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
    daemon.stderr?.on("data", (b: Buffer) => { daemonStderr += b.toString(); });
    await new Promise((r) => setTimeout(r, 400));

    const sockPath = join(stateDir, "daemon.sock");
    const fc = spawn("bun", [
      join(ROOT, "tools/fake-claude/fake-claude.ts"),
      "--session-id", "s_kill",
      "--cwd", "/tmp/kill",
      "--socket", sockPath,
    ], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    procs.push(fc);
    let fcExited = false;
    fc.on("exit", () => { fcExited = true; });
    await new Promise((r) => setTimeout(r, 400));

    // Connect PWA WSS, subscribe.
    const ws = new WebSocket(`ws://localhost:${HUB_PORT}/ws/pwa`);
    const inbox: HubToPwa[] = [];
    ws.addEventListener("message", (ev) => {
      try { inbox.push(JSON.parse(typeof ev.data === "string" ? ev.data : "") as HubToPwa); } catch {}
    });
    await new Promise<void>((res, rej) => {
      ws.addEventListener("open", () => res(), { once: true });
      ws.addEventListener("error", () => rej(new Error(`ws error; hub stderr: ${hubStderr.slice(-300)}`)), { once: true });
    });
    ws.send(JSON.stringify({ type: "subscribe" } satisfies PwaToHub));

    // Wait for session to surface.
    await waitFor(() => {
      for (const f of inbox) {
        if (f.type === "snapshot" && f.daemons.some((d) => d.sessions.some((s) => s.session_id === "s_kill"))) return true;
        if (f.type === "session_open" && f.session.session_id === "s_kill") return true;
      }
      return null;
    }, 3000, `s_kill to surface (daemon stderr: ${daemonStderr.slice(-300)})`);

    // Send kill_session.
    const killMsg: PwaToHub = {
      type: "kill_session",
      daemon_id: "kill-daemon",
      session_id: "s_kill",
    };
    ws.send(JSON.stringify(killMsg));

    // Wait for session_close arriving back.
    const closeFrame = await waitFor(() => {
      for (const f of inbox) {
        if (f.type === "session_close" && f.session_id === "s_kill") return f;
      }
      return null;
    }, 3000, `session_close (daemon stderr: ${daemonStderr.slice(-300)})`);
    expect((closeFrame as any).daemon_id).toBe("kill-daemon");

    // Wait for fake-claude to exit.
    await waitFor(() => fcExited ? true : null, 2000, `fake-claude to exit`);

    ws.close();
  } finally {
    cleanup();
  }
}, 30_000);

test("kill_session is ignored when allow_kill is false (default)", async () => {
  const root = mkdtempSync(join(tmpdir(), "ccr-k2-"));
  const stateDir = join(root, "daemon-state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "config.json"), JSON.stringify({
    daemon_id: "noKill-daemon",
    hub_url: `ws://localhost:${HUB_PORT + 1}`,
    // allow_kill omitted → defaults to false
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
    daemon.stderr?.on("data", (b: Buffer) => { daemonStderr += b.toString(); });
    await new Promise((r) => setTimeout(r, 400));

    const sockPath = join(stateDir, "daemon.sock");
    const fc = spawn("bun", [
      join(ROOT, "tools/fake-claude/fake-claude.ts"),
      "--session-id", "s_noKill",
      "--cwd", "/tmp/noKill",
      "--socket", sockPath,
    ], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    procs.push(fc);
    let fcExited = false;
    fc.on("exit", () => { fcExited = true; });
    await new Promise((r) => setTimeout(r, 400));

    const ws = new WebSocket(`ws://localhost:${HUB_PORT + 1}/ws/pwa`);
    const inbox: HubToPwa[] = [];
    ws.addEventListener("message", (ev) => {
      try { inbox.push(JSON.parse(typeof ev.data === "string" ? ev.data : "") as HubToPwa); } catch {}
    });
    await new Promise<void>((res) => {
      ws.addEventListener("open", () => res(), { once: true });
    });
    ws.send(JSON.stringify({ type: "subscribe" } satisfies PwaToHub));
    await waitFor(() => {
      for (const f of inbox) {
        if (f.type === "snapshot" && f.daemons.some((d) => d.sessions.some((s) => s.session_id === "s_noKill"))) return true;
        if (f.type === "session_open" && f.session.session_id === "s_noKill") return true;
      }
      return null;
    }, 3000, `s_noKill to surface`);

    ws.send(JSON.stringify({
      type: "kill_session",
      daemon_id: "noKill-daemon",
      session_id: "s_noKill",
    } satisfies PwaToHub));

    // Give it time. fake-claude should NOT exit.
    await new Promise((r) => setTimeout(r, 1000));
    expect(fcExited).toBe(false);
    expect(daemonStderr).toContain("kill_session ignored");

    ws.close();
  } finally {
    cleanup();
  }
}, 30_000);
