import { test, expect } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { HubToPwa, PwaToHub } from "@cc-remote/proto";
import { Database } from "bun:sqlite";

const ROOT = resolve(import.meta.dir, "..");
const HUB_PORT = 47945;

async function waitFor<T>(pred: () => T | null, timeoutMs: number, label: string): Promise<T> {
  const start = Date.now();
  while (true) {
    const r = pred();
    if (r) return r;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

test("end-to-end permission relay: plugin → daemon → hub → PWA → reply back, audit row exists", async () => {
  const root = mkdtempSync(join(tmpdir(), "ccr-perm-"));
  const stateDir = join(root, "daemon-state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "config.json"), JSON.stringify({
    daemon_id: "perm-daemon",
    hub_url: `ws://localhost:${HUB_PORT}`,
  }));

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
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    procs.push(daemon);
    let daemonStderr = "";
    daemon.stderr?.on("data", (b: Buffer) => { daemonStderr += b.toString(); });
    await new Promise((r) => setTimeout(r, 400));

    // Connect PWA WSS first so we don't miss the permission_request frame.
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

    const sockPath = join(stateDir, "daemon.sock");
    const fc = spawn("bun", [
      join(ROOT, "tools/fake-claude/fake-claude.ts"),
      "--session-id", "s_perm",
      "--cwd", "/tmp/perm",
      "--socket", sockPath,
      "--inject-permission", "Bash:req-e2e-1:rm -rf /tmp/test",
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    procs.push(fc);

    // Wait for permission_request frame.
    const req = await waitFor(() => {
      for (const f of inbox) {
        if (f.type === "permission_request" && f.request_id === "req-e2e-1") return f;
      }
      return null;
    }, 4000, `permission_request to arrive (daemon stderr: ${daemonStderr.slice(-400)})`);

    expect(req.type).toBe("permission_request");
    expect((req as any).daemon_id).toBe("perm-daemon");
    expect((req as any).session_id).toBe("s_perm");
    expect((req as any).tool).toBe("Bash");
    expect((req as any).args_summary).toBe("rm -rf /tmp/test");

    // Send permission_reply { decision: allow }
    const reply: PwaToHub = {
      type: "permission_reply",
      daemon_id: "perm-daemon",
      session_id: "s_perm",
      request_id: "req-e2e-1",
      decision: "allow",
    };
    ws.send(JSON.stringify(reply));

    // Wait for permission_resolved frame coming back.
    const resolved = await waitFor(() => {
      for (const f of inbox) {
        if (f.type === "permission_resolved" && f.request_id === "req-e2e-1") return f;
      }
      return null;
    }, 4000, `permission_resolved to arrive`);

    expect(resolved.type).toBe("permission_resolved");
    expect((resolved as any).decision).toBe("allow");
    expect((resolved as any).decided_via).toBe("pwa");

    // Verify SQLite audit row.
    const dbPath = join(stateDir, "db.sqlite");
    const db = new Database(dbPath, { readonly: true });
    const row = db.query("SELECT * FROM permissions WHERE request_id = ?").get("req-e2e-1") as any;
    db.close();
    expect(row).toBeTruthy();
    expect(row.tool).toBe("Bash");
    expect(row.decision).toBe("allow");
    expect(row.decided_via).toBe("pwa");
    expect(row.resolved_at).toBeTruthy();

    ws.close();
  } finally {
    cleanup();
  }
});
