import { test, expect } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { HubToPwa, PwaToHub } from "@cc-remote/proto";

const ROOT = resolve(import.meta.dir, "..");
const HUB_PORT = 48645;

async function waitFor<T>(pred: () => T | null, timeoutMs: number, label: string): Promise<T> {
  const start = Date.now();
  while (true) {
    const r = pred();
    if (r) return r;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function encodeCwd(cwd: string): string {
  return (cwd.replace(/\/+$/, "") || "/").replace(/\//g, "-");
}

test("idle event fires after idle_window_ms with no further activity", async () => {
  const root = mkdtempSync(join(tmpdir(), "ccr-idl-"));
  const stateDir = join(root, "daemon-state");
  const projectsDir = join(root, "projects");
  const sessionCwd = "/tmp/cc-idle";
  const sessionId = "s_idle";

  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "config.json"), JSON.stringify({
    daemon_id: "idle-daemon",
    hub_url: `ws://localhost:${HUB_PORT}`,
    idle_window_ms: 250,
  }));
  const sessionDir = join(projectsDir, encodeCwd(sessionCwd));
  mkdirSync(sessionDir, { recursive: true });
  const jsonlPath = join(sessionDir, `${sessionId}.jsonl`);
  writeFileSync(jsonlPath, "");

  const procs: ChildProcess[] = [];
  const cleanup = () => {
    for (const p of procs.reverse()) try { p.kill("SIGTERM"); } catch {}
    rmSync(root, { recursive: true, force: true });
  };

  try {
    const hub = spawn("bun", ["run", join(ROOT, "packages/hub/src/index.ts")], {
      env: { ...process.env, HUB_PORT: String(HUB_PORT), HUB_DISABLE_AUTH: "1",
        HUB_DB_PATH: join(root, "hub.sqlite"), HUB_JWT_SECRET: "s" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    procs.push(hub);
    await new Promise((r) => setTimeout(r, 300));

    const daemon = spawn("bun", ["run", join(ROOT, "packages/daemon/src/index.ts")], {
      env: { ...process.env, CC_REMOTE_STATE_DIR: stateDir, CLAUDE_PROJECTS_DIR: projectsDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    procs.push(daemon);
    let daemonStderr = "";
    daemon.stderr?.on("data", (b: Buffer) => { daemonStderr += b.toString(); });
    await new Promise((r) => setTimeout(r, 400));

    const sockPath = join(stateDir, "daemon.sock");
    const fc = spawn("bun", [
      join(ROOT, "tools/fake-claude/fake-claude.ts"),
      "--session-id", sessionId,
      "--cwd", sessionCwd,
      "--socket", sockPath,
    ], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    procs.push(fc);
    await new Promise((r) => setTimeout(r, 400));

    const ws = new WebSocket(`ws://localhost:${HUB_PORT}/ws/pwa`);
    const inbox: HubToPwa[] = [];
    ws.addEventListener("message", (ev) => {
      try { inbox.push(JSON.parse(typeof ev.data === "string" ? ev.data : "") as HubToPwa); } catch {}
    });
    await new Promise<void>((res, rej) => {
      ws.addEventListener("open", () => res(), { once: true });
      ws.addEventListener("error", () => rej(new Error("ws error")), { once: true });
    });
    ws.send(JSON.stringify({ type: "subscribe" } satisfies PwaToHub));
    await waitFor(() => {
      for (const f of inbox) {
        if (f.type === "snapshot" && f.daemons.some((d) => d.sessions.some((s) => s.session_id === sessionId))) return true;
        if (f.type === "session_open" && f.session.session_id === sessionId) return true;
      }
      return null;
    }, 3000, `${sessionId} surface`);

    // Append assistant + end_turn → triggers task_completed AND schedules idle.
    const line = JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "done" }], stop_reason: "end_turn" },
    });
    appendFileSync(jsonlPath, line + "\n");

    // Wait for idle frame.
    const idle = await waitFor(() => {
      for (const f of inbox) {
        if (f.type === "idle" && f.session_id === sessionId) return f;
      }
      return null;
    }, 3000, `idle (daemon stderr: ${daemonStderr.slice(-300)})`);

    expect(idle.type).toBe("idle");
    expect((idle as any).daemon_id).toBe("idle-daemon");
    expect((idle as any).session_id).toBe(sessionId);

    ws.close();
  } finally {
    cleanup();
  }
}, 30_000);

test("idle event is cancelled by a new line within the window", async () => {
  const root = mkdtempSync(join(tmpdir(), "ccr-idl2-"));
  const stateDir = join(root, "daemon-state");
  const projectsDir = join(root, "projects");
  const sessionCwd = "/tmp/cc-idle-cancel";
  const sessionId = "s_idle_cancel";

  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "config.json"), JSON.stringify({
    daemon_id: "idle-cancel-daemon",
    hub_url: `ws://localhost:${HUB_PORT + 1}`,
    idle_window_ms: 500,
  }));
  const sessionDir = join(projectsDir, encodeCwd(sessionCwd));
  mkdirSync(sessionDir, { recursive: true });
  const jsonlPath = join(sessionDir, `${sessionId}.jsonl`);
  writeFileSync(jsonlPath, "");

  const procs: ChildProcess[] = [];
  const cleanup = () => {
    for (const p of procs.reverse()) try { p.kill("SIGTERM"); } catch {}
    rmSync(root, { recursive: true, force: true });
  };

  try {
    const hub = spawn("bun", ["run", join(ROOT, "packages/hub/src/index.ts")], {
      env: { ...process.env, HUB_PORT: String(HUB_PORT + 1), HUB_DISABLE_AUTH: "1",
        HUB_DB_PATH: join(root, "hub.sqlite"), HUB_JWT_SECRET: "s" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    procs.push(hub);
    await new Promise((r) => setTimeout(r, 300));

    const daemon = spawn("bun", ["run", join(ROOT, "packages/daemon/src/index.ts")], {
      env: { ...process.env, CC_REMOTE_STATE_DIR: stateDir, CLAUDE_PROJECTS_DIR: projectsDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    procs.push(daemon);
    await new Promise((r) => setTimeout(r, 400));

    const sockPath = join(stateDir, "daemon.sock");
    const fc = spawn("bun", [
      join(ROOT, "tools/fake-claude/fake-claude.ts"),
      "--session-id", sessionId,
      "--cwd", sessionCwd,
      "--socket", sockPath,
    ], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    procs.push(fc);
    await new Promise((r) => setTimeout(r, 400));

    const ws = new WebSocket(`ws://localhost:${HUB_PORT + 1}/ws/pwa`);
    const inbox: HubToPwa[] = [];
    ws.addEventListener("message", (ev) => {
      try { inbox.push(JSON.parse(typeof ev.data === "string" ? ev.data : "") as HubToPwa); } catch {}
    });
    await new Promise<void>((res) => { ws.addEventListener("open", () => res(), { once: true }); });
    ws.send(JSON.stringify({ type: "subscribe" } satisfies PwaToHub));
    await waitFor(() => {
      for (const f of inbox) {
        if (f.type === "snapshot" && f.daemons.some((d) => d.sessions.some((s) => s.session_id === sessionId))) return true;
        if (f.type === "session_open" && f.session.session_id === sessionId) return true;
      }
      return null;
    }, 3000, `surface`);

    // Append assistant + end_turn → schedules idle in 500ms.
    const completedLine = JSON.stringify({
      type: "assistant",
      message: { stop_reason: "end_turn", role: "assistant", content: [] },
    });
    appendFileSync(jsonlPath, completedLine + "\n");

    // 200ms later, append a user line (cancels idle timer).
    await new Promise((r) => setTimeout(r, 200));
    appendFileSync(jsonlPath, JSON.stringify({ type: "user", message: { content: "more" } }) + "\n");

    // Wait past the original 500ms window — idle should NOT fire.
    await new Promise((r) => setTimeout(r, 500));
    const idleSeen = inbox.some((f) => f.type === "idle");
    expect(idleSeen).toBe(false);

    ws.close();
  } finally {
    cleanup();
  }
}, 30_000);
