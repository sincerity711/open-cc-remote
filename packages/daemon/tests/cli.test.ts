import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDb } from "../../hub/src/db.ts";
import { issueCode } from "../../hub/src/repos/pairing-codes.ts";
import { makeServer } from "../../hub/src/routes.ts";

const ROOT = resolve(import.meta.dir, "../../..");

test("cc-remote pair against real hub writes config.json + state.json", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-cli-"));
  const stateDir = join(dir, "state");

  const db = openDb(join(dir, "h.sqlite"));
  db.prepare("INSERT INTO users (sub, created_at) VALUES (?, ?)").run("u1", 1);
  const code = issueCode(db, "daemon", "u1", null, 60_000);

  const { fetch, websocket } = makeServer({ db, jwt_secret: "s", disable_auth: false });
  const hub = Bun.serve({ port: 0, fetch, websocket });

  try {
    const cliPath = join(ROOT, "packages/daemon/bin/cc-remote.ts");
    const proc = spawn(
      "bun",
      [cliPath, "pair",
        "--hub", `http://localhost:${hub.port}`,
        "--code", code,
        "--daemon-id", "test-mac",
      ],
      {
        env: { ...process.env, CC_REMOTE_STATE_DIR: stateDir },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    proc.stderr?.on("data", (b: Buffer) => { stderr += b.toString(); });

    const exitCode = await new Promise<number>((res) => proc.on("exit", (c) => res(c ?? 0)));
    expect(exitCode).toBe(0);

    expect(existsSync(join(stateDir, "config.json"))).toBe(true);
    expect(existsSync(join(stateDir, "state.json"))).toBe(true);
    expect(existsSync(join(stateDir, "private.jwk"))).toBe(true);
    expect(existsSync(join(stateDir, "public.jwk"))).toBe(true);

    const cfg = JSON.parse(readFileSync(join(stateDir, "config.json"), "utf8"));
    expect(cfg.daemon_id).toBe("test-mac");
    expect(cfg.hub_url).toBe(`http://localhost:${hub.port}`);

    const state = JSON.parse(readFileSync(join(stateDir, "state.json"), "utf8"));
    expect(state.jwt).toBeTruthy();
    expect(state.paired_at).toBeTruthy();
    expect(state.exp).toBeTruthy();
  } finally {
    hub.stop(true);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cc-remote pair with bad code exits non-zero", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-cli-"));
  const stateDir = join(dir, "state");
  const db = openDb(join(dir, "h.sqlite"));
  const { fetch, websocket } = makeServer({ db, jwt_secret: "s", disable_auth: false });
  const hub = Bun.serve({ port: 0, fetch, websocket });
  try {
    const cliPath = join(ROOT, "packages/daemon/bin/cc-remote.ts");
    const proc = spawn(
      "bun",
      [cliPath, "pair",
        "--hub", `http://localhost:${hub.port}`,
        "--code", "BOGUS-CODE",
        "--daemon-id", "x",
      ],
      { env: { ...process.env, CC_REMOTE_STATE_DIR: stateDir }, stdio: ["ignore", "pipe", "pipe"] },
    );
    const exitCode = await new Promise<number>((res) => proc.on("exit", (c) => res(c ?? 0)));
    expect(exitCode).not.toBe(0);
    expect(existsSync(join(stateDir, "state.json"))).toBe(false);
  } finally {
    hub.stop(true);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cc-remote with no subcommand prints usage and exits non-zero", async () => {
  const cliPath = join(ROOT, "packages/daemon/bin/cc-remote.ts");
  const proc = spawn("bun", [cliPath, "what"], { stdio: ["ignore", "pipe", "pipe"] });
  const exitCode = await new Promise<number>((res) => proc.on("exit", (c) => res(c ?? 0)));
  expect(exitCode).not.toBe(0);
});
