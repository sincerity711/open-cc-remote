import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { platform } from "node:os";

const ROOT = resolve(import.meta.dir, "../../..");
const CLI = resolve(ROOT, "packages/daemon/bin/cc-remote.ts");

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = spawn("bun", [CLI, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  proc.stdout?.on("data", (b: Buffer) => { stdout += b.toString(); });
  proc.stderr?.on("data", (b: Buffer) => { stderr += b.toString(); });
  const code = await new Promise<number>((res) => proc.on("exit", (c) => res(c ?? 0)));
  return { code, stdout, stderr };
}

const isSupportedPlatform = platform() === "darwin" || platform() === "linux";

test.skipIf(!isSupportedPlatform)("install --dry-run prints unit file path and would-run commands", async () => {
  const { code, stdout } = await run(["install", "--dry-run"]);
  expect(code).toBe(0);
  expect(stdout).toContain("platform:");
  expect(stdout).toContain("unit file:");
  expect(stdout).toContain("--- unit content ---");
  expect(stdout).toContain("would run:");
  if (platform() === "darwin") {
    expect(stdout).toContain("launchctl");
    expect(stdout).toContain("com.cc-remote.daemon.plist");
  } else {
    expect(stdout).toContain("systemctl");
    expect(stdout).toContain("cc-remote-daemon.service");
  }
});

test.skipIf(!isSupportedPlatform)("uninstall --dry-run prints stop/disable plan", async () => {
  const { code, stdout } = await run(["uninstall", "--dry-run"]);
  expect(code).toBe(0);
  expect(stdout).toContain("platform:");
  expect(stdout).toContain("unit file:");
  if (platform() === "darwin") {
    expect(stdout).toContain("launchctl unload");
  } else {
    expect(stdout).toContain("systemctl --user stop");
  }
  expect(stdout).toContain("would remove:");
});
