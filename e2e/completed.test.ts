import { test, expect } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { HubToPwa, PwaToHub } from "@cc-remote/proto";

const ROOT = resolve(import.meta.dir, "..");
const HUB_PORT = 48545;

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

test("assistant line with stop_reason=end_turn surfaces as task_completed", async () => {
  const root = mkdtempSync(join(tmpdir(), "ccr-tc-"));
  const stateDir = join(root, "daemon-state");
  const projectsDir = join(root, "projects");
  const sessionCwd = "/tmp/cc-completed";
  const sessionId = "s_complete";

  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "config.json"), JSON.stringify({
    daemon_id: "tc-daemon",
    hub_url: `ws://localhost:${HUB_PORT}`,
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
      env: {
        ...process.env, HUB_PORT: String(HUB_PORT), HUB_DISABLE_AUTH: "1",
        HUB_DB_PATH: join(root, "hub.sqlite"), HUB_JWT_SECRET: "s",
      },
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
    }, 3000, `${sessionId} surface (daemon stderr: ${daemonStderr.slice(-400)})`);

    // Append an assistant line with stop_reason: end_turn.
    const assistantLine = JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "done" }], stop_reason: "end_turn" },
    });
    appendFileSync(jsonlPath, assistantLine + "\n");

    const completed = await waitFor(() => {
      for (const f of inbox) {
        if (f.type === "task_completed" && f.session_id === sessionId) return f;
      }
      return null;
    }, 3000, `task_completed (daemon stderr: ${daemonStderr.slice(-400)})`);

    expect(completed.type).toBe("task_completed");
    expect((completed as any).daemon_id).toBe("tc-daemon");
    expect((completed as any).session_id).toBe(sessionId);
    expect((completed as any).ts).toBeGreaterThan(0);

    ws.close();
  } finally {
    cleanup();
  }
}, 30_000);

test("assistant line WITHOUT stop_reason=end_turn does not emit task_completed", async () => {
  const root = mkdtempSync(join(tmpdir(), "ccr-tc2-"));
  const stateDir = join(root, "daemon-state");
  const projectsDir = join(root, "projects");
  const sessionCwd = "/tmp/cc-no-completed";
  const sessionId = "s_noComplete";

  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "config.json"), JSON.stringify({
    daemon_id: "tc2-daemon",
    hub_url: `ws://localhost:${HUB_PORT + 1}`,
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
      env: {
        ...process.env, HUB_PORT: String(HUB_PORT + 1), HUB_DISABLE_AUTH: "1",
        HUB_DB_PATH: join(root, "hub.sqlite"), HUB_JWT_SECRET: "s",
      },
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
    await new Promise<void>((res) => {
      ws.addEventListener("open", () => res(), { once: true });
    });
    ws.send(JSON.stringify({ type: "subscribe" } satisfies PwaToHub));
    await waitFor(() => {
      for (const f of inbox) {
        if (f.type === "snapshot" && f.daemons.some((d) => d.sessions.some((s) => s.session_id === sessionId))) return true;
        if (f.type === "session_open" && f.session.session_id === sessionId) return true;
      }
      return null;
    }, 3000, `${sessionId} surface`);

    // tool_use line — should NOT trigger task_completed.
    const tool_use = JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", name: "Read" }], stop_reason: "tool_use" },
    });
    appendFileSync(jsonlPath, tool_use + "\n");

    await new Promise((r) => setTimeout(r, 800));
    const found = inbox.some((f) => f.type === "task_completed");
    expect(found).toBe(false);

    ws.close();
  } finally {
    cleanup();
  }
}, 30_000);
