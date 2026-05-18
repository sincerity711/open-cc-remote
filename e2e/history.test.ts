import { test, expect } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { HubToPwa, PwaToHub } from "@cc-remote/proto";

const ROOT = resolve(import.meta.dir, "..");
const HUB_PORT = 48045;

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

test("PWA request_history surfaces JSONL history via daemon", async () => {
  const root = mkdtempSync(join(tmpdir(), "ccr-h-"));
  const stateDir = join(root, "daemon-state");
  const projectsDir = join(root, "projects");
  const sessionCwd = "/tmp/cc-remote-h";
  const sessionId = "s_e2e_h";

  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "config.json"), JSON.stringify({
    daemon_id: "h-daemon",
    hub_url: `ws://localhost:${HUB_PORT}`,
  }));

  // Pre-create JSONL with 5 lines.
  const sessionDir = join(projectsDir, encodeCwd(sessionCwd));
  mkdirSync(sessionDir, { recursive: true });
  const jsonlPath = join(sessionDir, `${sessionId}.jsonl`);
  const content = [
    JSON.stringify({ type: "user", n: 1 }),
    JSON.stringify({ type: "assistant", n: 2 }),
    JSON.stringify({ type: "tool_use", n: 3 }),
    JSON.stringify({ type: "tool_result", n: 4 }),
    JSON.stringify({ type: "assistant", n: 5 }),
  ].join("\n") + "\n";
  writeFileSync(jsonlPath, content);

  const procs: ChildProcess[] = [];
  const cleanup = () => {
    for (const p of procs.reverse()) try { p.kill("SIGTERM"); } catch {}
    rmSync(root, { recursive: true, force: true });
  };

  try {
    const hub = spawn("bun", ["run", join(ROOT, "packages/hub/src/index.ts")], {
      env: {
        ...process.env,
        HUB_PORT: String(HUB_PORT),
        HUB_DISABLE_AUTH: "1",
        HUB_DB_PATH: join(root, "hub.sqlite"),
        HUB_JWT_SECRET: "test-secret",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    procs.push(hub);
    let hubStderr = "";
    hub.stderr?.on("data", (b: Buffer) => { hubStderr += b.toString(); });
    await new Promise((r) => setTimeout(r, 300));

    const daemon = spawn("bun", ["run", join(ROOT, "packages/daemon/src/index.ts")], {
      env: {
        ...process.env,
        CC_REMOTE_STATE_DIR: stateDir,
        CLAUDE_PROJECTS_DIR: projectsDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    procs.push(daemon);
    let daemonStderr = "";
    daemon.stderr?.on("data", (b: Buffer) => { daemonStderr += b.toString(); });
    await new Promise((r) => setTimeout(r, 400));

    // fake-claude registers the session.
    const sockPath = join(stateDir, "daemon.sock");
    const fc = spawn("bun", [
      join(ROOT, "tools/fake-claude/fake-claude.ts"),
      "--session-id", sessionId,
      "--cwd", sessionCwd,
      "--socket", sockPath,
    ], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    procs.push(fc);
    await new Promise((r) => setTimeout(r, 400));

    // Connect PWA-style WSS.
    const ws = new WebSocket(`ws://localhost:${HUB_PORT}/ws/pwa`);
    const inbox: HubToPwa[] = [];
    ws.addEventListener("message", (ev) => {
      try { inbox.push(JSON.parse(typeof ev.data === "string" ? ev.data : "") as HubToPwa); } catch {}
    });
    await new Promise<void>((res, rej) => {
      ws.addEventListener("open", () => res(), { once: true });
      ws.addEventListener("error", () => rej(new Error(`ws error; hub stderr: ${hubStderr.slice(-300)}`)), { once: true });
    });
    const sub: PwaToHub = { type: "subscribe" };
    ws.send(JSON.stringify(sub));

    // Wait for the session to surface.
    await waitFor(() => {
      for (const f of inbox) {
        if (f.type === "snapshot" && f.daemons.some((d) => d.sessions.some((s) => s.session_id === sessionId))) return true;
        if (f.type === "session_open" && f.session.session_id === sessionId) return true;
      }
      return null;
    }, 3000, `session ${sessionId} to surface (daemon stderr: ${daemonStderr.slice(-400)})`);

    // Send request_history with before_offset = file size.
    const fileSize = Buffer.byteLength(content, "utf8");
    const reqId = "rh-test-1";
    const reqMsg: PwaToHub = {
      type: "request_history",
      daemon_id: "h-daemon",
      session_id: sessionId,
      request_id: reqId,
      before_offset: fileSize,
      limit: 100,
    };
    ws.send(JSON.stringify(reqMsg));

    // Wait for history_chunk.
    const chunk = await waitFor(() => {
      for (const f of inbox) {
        if (f.type === "history_chunk" && f.request_id === reqId) return f;
      }
      return null;
    }, 4000, `history_chunk to arrive (daemon stderr: ${daemonStderr.slice(-400)})`);

    expect(chunk.type).toBe("history_chunk");
    expect((chunk as any).daemon_id).toBe("h-daemon");
    expect((chunk as any).session_id).toBe(sessionId);
    expect((chunk as any).events).toHaveLength(5);
    const events = (chunk as any).events as Array<{ jsonl_offset: number; payload: { n: number } }>;
    for (let i = 0; i < 5; i++) {
      expect(events[i].payload.n).toBe(i + 1);
    }
    // Offsets should be strictly increasing.
    for (let i = 1; i < 5; i++) {
      expect(events[i].jsonl_offset).toBeGreaterThan(events[i - 1].jsonl_offset);
    }

    ws.close();
  } finally {
    cleanup();
  }
});
