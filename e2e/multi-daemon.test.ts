import { test, expect } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { HubToPwa, PwaToHub } from "@cc-remote/proto";

const ROOT = resolve(import.meta.dir, "..");
const HUB_PORT = 48245;
const DAEMONS = ["mac-1", "mac-2", "linux-3"];

async function waitFor<T>(pred: () => T | null, timeoutMs: number, label: string): Promise<T> {
  const start = Date.now();
  while (true) {
    const r = pred();
    if (r) return r;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

test("3 concurrent daemons all surface in PWA snapshot", async () => {
  const root = mkdtempSync(join(tmpdir(), "ccr-md-"));
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

    for (const daemon_id of DAEMONS) {
      const stateDir = join(root, `state-${daemon_id}`);
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, "config.json"), JSON.stringify({
        daemon_id,
        hub_url: `ws://localhost:${HUB_PORT}`,
      }));
      const daemon = spawn("bun", ["run", join(ROOT, "packages/daemon/src/index.ts")], {
        env: { ...process.env, CC_REMOTE_STATE_DIR: stateDir },
        stdio: ["ignore", "pipe", "pipe"],
      });
      procs.push(daemon);
      await new Promise((r) => setTimeout(r, 200));

      const sockPath = join(stateDir, "daemon.sock");
      const fc = spawn("bun", [
        join(ROOT, "tools/fake-claude/fake-claude.ts"),
        "--session-id", `s-${daemon_id}`,
        "--cwd", `/tmp/${daemon_id}`,
        "--socket", sockPath,
      ], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
      procs.push(fc);
    }

    await new Promise((r) => setTimeout(r, 600));

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

    function viewState(): Map<string, Set<string>> {
      const view = new Map<string, Set<string>>();
      for (const f of inbox) {
        if (f.type === "snapshot") {
          for (const d of f.daemons) {
            const s = view.get(d.daemon_id) ?? new Set<string>();
            for (const sess of d.sessions) s.add(sess.session_id);
            view.set(d.daemon_id, s);
          }
        } else if (f.type === "daemon_online") {
          const s = view.get(f.daemon_id) ?? new Set<string>();
          for (const sess of f.sessions) s.add(sess.session_id);
          view.set(f.daemon_id, s);
        } else if (f.type === "session_open") {
          const s = view.get(f.daemon_id) ?? new Set<string>();
          s.add(f.session.session_id);
          view.set(f.daemon_id, s);
        }
      }
      return view;
    }

    await waitFor(() => {
      const view = viewState();
      for (const id of DAEMONS) {
        const sessions = view.get(id);
        if (!sessions || !sessions.has(`s-${id}`)) return null;
      }
      return view;
    }, 6000, `all 3 daemons + sessions to surface`);

    const view = viewState();
    expect(view.size).toBeGreaterThanOrEqual(DAEMONS.length);
    for (const id of DAEMONS) {
      expect(view.get(id)?.has(`s-${id}`)).toBe(true);
    }

    ws.close();
  } finally {
    cleanup();
  }
}, 30_000);
