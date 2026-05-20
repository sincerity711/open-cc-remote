// Helpers for docker compose lifecycle in e2e-real tests.
// All functions operate on the compose file at e2e-real/docker-compose.yml.

import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const composeDir = resolve(__dirname, "..");
const composeFile = resolve(composeDir, "docker-compose.yml");

function runCompose(args: string[], opts: { timeoutMs?: number } = {}): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("docker", ["compose", "-f", composeFile, ...args], {
    cwd: composeDir,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 180_000,
  });
  return {
    code: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

function dumpLogs(): string {
  const r = runCompose(["logs", "--tail", "200"]);
  return r.stdout + r.stderr;
}

export async function upCompose(): Promise<void> {
  const r = runCompose(["up", "-d", "--wait"], { timeoutMs: 300_000 });
  if (r.code !== 0) {
    const logs = dumpLogs();
    throw new Error(
      `docker compose up failed (code ${r.code}).\n` +
      `stderr:\n${r.stderr}\nstdout:\n${r.stdout}\n` +
      `--- logs ---\n${logs}\n`,
    );
  }
}

/**
 * Spec §9 #7: kill any tmux sessions whose name starts with `ccr-` so a
 * crashed scenario doesn't leave orphan claude processes behind. Safe to
 * call when no such sessions exist (silently no-ops). Best-effort: never
 * throws — teardown must always make progress.
 */
export function sweepCcrTmuxSessions(): string[] {
  const ls = spawnSync("tmux", ["list-sessions", "-F", "#S"], { encoding: "utf8" });
  if ((ls.status ?? -1) !== 0) return [];
  const names = (ls.stdout ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("ccr-"));
  for (const name of names) {
    spawnSync("tmux", ["kill-session", "-t", name], { encoding: "utf8" });
  }
  return names;
}

export async function downCompose(): Promise<void> {
  // Sweep orphan tmux sessions FIRST: if a scenario crashed mid-run with a
  // claude+plugin still attached to the daemon, that plugin's socket holds
  // the daemon socket open which can keep `docker compose down` waiting on
  // network drain. Killing those tmux sessions releases everything cleanly.
  // Best-effort, never throws.
  try {
    const swept = sweepCcrTmuxSessions();
    if (swept.length > 0) {
      process.stderr.write(`[downCompose] swept ${swept.length} orphan tmux sessions: ${swept.join(", ")}\n`);
    }
  } catch (e) {
    process.stderr.write(`[downCompose] tmux sweep failed (continuing): ${(e as Error).message}\n`);
  }

  // Use a tight timeout (10s) and SIGKILL behaviour: tests that crash mid-run
  // sometimes leave containers in a state that takes minutes to drain
  // gracefully. Tests don't need a graceful drain.
  const r = runCompose(["down", "-v", "-t", "5"], { timeoutMs: 30_000 });
  if (r.code !== 0) {
    process.stderr.write(`docker compose down -v failed: ${r.stderr}\n`);
  }
}

export function execHubCmd(argv: string[]): string {
  const r = spawnSync("docker", ["compose", "-f", composeFile, "exec", "-T", "hub", ...argv], {
    cwd: composeDir,
    encoding: "utf8",
    timeout: 60_000,
  });
  if ((r.status ?? -1) !== 0) {
    throw new Error(
      `execHubCmd failed (code ${r.status}): ${argv.join(" ")}\nstderr:\n${r.stderr}\nstdout:\n${r.stdout}`,
    );
  }
  return r.stdout;
}
