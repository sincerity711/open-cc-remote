import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";

const ROOT = resolve(import.meta.dir, "../../..");
const CLI = resolve(ROOT, "packages/daemon/bin/cc-remote.ts");

async function run(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = spawn("bun", [CLI, ...args], { stdio: ["ignore", "pipe", "pipe"], env });
  let stdout = ""; let stderr = "";
  proc.stdout?.on("data", (b: Buffer) => { stdout += b.toString(); });
  proc.stderr?.on("data", (b: Buffer) => { stderr += b.toString(); });
  const code = await new Promise<number>((res) => proc.on("exit", (c) => res(c ?? 0)));
  return { code, stdout, stderr };
}

test("cc-remote status reports unpaired when no state.json", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-stat-"));
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      daemon_id: "stat-d", hub_url: "ws://example/x",
    }));
    const r = await run(["status"], { ...process.env, CC_REMOTE_STATE_DIR: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("daemon_id:");
    expect(r.stdout).toContain("stat-d");
    expect(r.stdout).toContain("hub_url:");
    expect(r.stdout).toContain("ws://example/x");
    expect(r.stdout).toContain("paired:              no");
    expect(r.stdout).toContain("permissions:         no audit DB yet");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("cc-remote status reports paired + jwt_exp + permissions when present", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-stat2-"));
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      daemon_id: "stat-d2", hub_url: "ws://example/x", allow_kill: true,
    }));
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    writeFileSync(join(dir, "state.json"), JSON.stringify({
      jwt: "fake-jwt-string",
      paired_at: Date.now(),
      exp: futureExp,
    }));
    // Create a permissions DB.
    const db = new Database(join(dir, "db.sqlite"), { create: true });
    db.exec(`CREATE TABLE permissions (
      request_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      tool TEXT NOT NULL, args_summary TEXT NOT NULL,
      created_at INTEGER NOT NULL, resolved_at INTEGER, decision TEXT, decided_via TEXT
    )`);
    db.prepare("INSERT INTO permissions (request_id, session_id, tool, args_summary, created_at, resolved_at, decision, decided_via) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("r1", "s1", "Bash", "ls -la", Date.now() - 5_000, Date.now() - 4_500, "allow", "pwa");
    db.prepare("INSERT INTO permissions (request_id, session_id, tool, args_summary, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("r2", "s1", "Edit", "fix bug", Date.now() - 1_000);
    db.close();

    const r = await run(["status"], { ...process.env, CC_REMOTE_STATE_DIR: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("paired:              yes");
    expect(r.stdout).toContain("jwt_exp:");
    expect(r.stdout).toContain("allow_kill:          true");
    expect(r.stdout).toContain("permissions logged:  2");
    expect(r.stdout).toContain("Bash");
    expect(r.stdout).toContain("allow via pwa");
    expect(r.stdout).toContain("PENDING");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
