import { test, expect } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { HubToPwa, PwaToHub } from "@cc-remote/proto";

const ROOT = resolve(import.meta.dir, "..");
const HUB_PORT = 47845;

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

test("appending a JSONL line surfaces an event frame at the PWA WSS", async () => {
  const root = mkdtempSync(join(tmpdir(), "ccr-tx-"));
  const stateDir = join(root, "daemon-state");
  const projectsDir = join(root, "projects");
  const sessionCwd = "/tmp/cc-remote-tx";
  const sessionId = "s_e2e_tx";

  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "config.json"), JSON.stringify({
    daemon_id: "tx-daemon",
    hub_url: `ws://localhost:${HUB_PORT}`,
  }));
  // Pre-create the JSONL parent dir so watcher's parent fs.watch is set up.
  const sessionDir = join(projectsDir, encodeCwd(sessionCwd));
  mkdirSync(sessionDir, { recursive: true });
  const jsonlPath = join(sessionDir, `${sessionId}.jsonl`);
  writeFileSync(jsonlPath, ""); // empty — watcher starts at offset 0 of an empty file

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

    // fake-claude registers the session. The daemon will then start a watcher
    // on jsonlPath above.
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

    // Wait for the session to surface in the snapshot/session_open before appending.
    await waitFor(() => {
      for (const f of inbox) {
        if (f.type === "snapshot" && f.daemons.some((d) => d.sessions.some((s) => s.session_id === sessionId))) return true;
        if (f.type === "session_open" && f.session.session_id === sessionId) return true;
      }
      return null;
    }, 3000, `session ${sessionId} to surface (daemon stderr: ${daemonStderr.slice(-400)})`);

    // Append a JSONL line.
    const line = JSON.stringify({ type: "user", message: { role: "user", content: "hello from e2e" } });
    appendFileSync(jsonlPath, line + "\n");

    // Wait for the event frame to arrive.
    const evt = await waitFor(() => {
      for (const f of inbox) {
        if (f.type === "event" && f.session_id === sessionId) return f;
      }
      return null;
    }, 3000, `event frame for ${sessionId}`);

    expect(evt.type).toBe("event");
    expect(evt.session_id).toBe(sessionId);
    expect(evt.jsonl_offset).toBe(line.length + 1); // including newline
    const payload = evt.payload as { type: string; message: { content: string } };
    expect(payload.type).toBe("user");
    expect(payload.message.content).toBe("hello from e2e");

    ws.close();
  } finally {
    cleanup();
  }
});
