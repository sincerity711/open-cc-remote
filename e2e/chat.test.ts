import { test, expect } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { HubToPwa, PwaToHub } from "@cc-remote/proto";

const ROOT = resolve(import.meta.dir, "..");
const HUB_PORT = 47746;

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

test("PWA chat_send → fake-claude chat_in → fake-claude chat_out → PWA broadcast", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ccr-e2e-chat-"));
  writeFileSync(join(stateDir, "config.json"), JSON.stringify({
    daemon_id: "chat-daemon",
    hub_url: `ws://localhost:${HUB_PORT}`,
  }));

  const procs: ChildProcess[] = [];
  const cleanup = () => {
    for (const p of procs.reverse()) try { p.kill("SIGTERM"); } catch {}
    rmSync(stateDir, { recursive: true, force: true });
  };

  try {
    // Hub
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
    await waitFor(() => hub.stdout?.readable ? true : null, 2000, "hub ready");
    await new Promise((r) => setTimeout(r, 200));

    // Daemon
    const daemon = spawn("bun", ["run", join(ROOT, "packages/daemon/src/index.ts")], {
      env: { ...process.env, CC_REMOTE_STATE_DIR: stateDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    procs.push(daemon);
    await waitFor(() => daemon.stdout?.readable ? true : null, 2000, "daemon ready");
    await new Promise((r) => setTimeout(r, 300));

    // fake-claude with auto-reply enabled
    const sockPath = join(stateDir, "daemon.sock");
    const fc = spawn("bun", [
      join(ROOT, "tools/fake-claude/fake-claude.ts"),
      "--session-id", "s_chat",
      "--cwd", "/tmp/e2e-chat",
      "--socket", sockPath,
      "--auto-reply", "pong",
    ], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    procs.push(fc);

    // Connect as PWA, subscribe, wait for the session to appear.
    const ws = new WebSocket(`ws://localhost:${HUB_PORT}/ws/pwa`);
    const inbox: HubToPwa[] = [];
    ws.addEventListener("message", (ev) => {
      try { inbox.push(JSON.parse(typeof ev.data === "string" ? ev.data : "") as HubToPwa); } catch {}
    });
    await awaitOpen(ws);
    const sub: PwaToHub = { type: "subscribe" };
    ws.send(JSON.stringify(sub));

    await waitFor(() => {
      for (const f of inbox) {
        if (f.type === "snapshot" && f.daemons.some((d) => d.daemon_id === "chat-daemon" && d.sessions.some((s) => s.session_id === "s_chat"))) return true;
        if (f.type === "session_open" && f.daemon_id === "chat-daemon" && f.session.session_id === "s_chat") return true;
      }
      return null;
    }, 5000, "session s_chat to appear");

    // Send chat_send "ping"
    const send: PwaToHub = {
      type: "chat_send",
      daemon_id: "chat-daemon",
      session_id: "s_chat",
      content: "ping",
    };
    ws.send(JSON.stringify(send));

    // Wait for the echo (from: "pwa")
    const echo = await waitFor(() => {
      for (const f of inbox) {
        if (f.type === "chat" && f.from === "pwa" && f.content === "ping" && f.session_id === "s_chat") return f;
      }
      return null;
    }, 2000, "chat echo from=pwa");
    expect(echo.daemon_id).toBe("chat-daemon");
    expect(typeof echo.message_id).toBe("string");
    expect(echo.message_id.length).toBeGreaterThan(0);

    // Wait for claude's reply (from: "claude", content: "pong")
    const reply = await waitFor(() => {
      for (const f of inbox) {
        if (f.type === "chat" && f.from === "claude" && f.content === "pong" && f.session_id === "s_chat") return f;
      }
      return null;
    }, 3000, "chat reply from=claude pong");
    expect(reply.user).toBeNull();
    expect(reply.daemon_id).toBe("chat-daemon");
    expect(typeof reply.message_id).toBe("string");

    ws.close();
    fc.kill("SIGTERM");
    await waitFor(() => fc.exitCode !== null ? true : null, 8000, "fake-claude exit");
  } finally {
    cleanup();
  }
}, 30_000);
