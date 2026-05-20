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

/**
 * Returns true if the host TCP port is currently bound by some process.
 * Uses Node's net module — fast, no shell dependency.
 */
async function isPortBound(port: number, host = "127.0.0.1"): Promise<boolean> {
  const net = await import("node:net");
  return new Promise((resolveBound) => {
    const sock = net.createConnection({ host, port });
    sock.once("connect", () => { sock.end(); resolveBound(true); });
    sock.once("error", () => resolveBound(false));
    setTimeout(() => { try { sock.destroy(); } catch {} resolveBound(false); }, 500);
  });
}

async function waitPortFree(port: number, deadlineMs: number): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (!(await isPortBound(port))) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

export async function upCompose(): Promise<void> {
  // Pre-flight: any leftover container/volume/tmux from a prior crashed
  // scenario must be torn down before `up --wait` is meaningful. Without
  // this, `up --wait` on a stale-but-unhealthy container hangs until the
  // 300s timeout, killing the whole suite.
  try {
    const swept = sweepCcrTmuxSessions();
    if (swept.length > 0) {
      process.stderr.write(`[upCompose] swept ${swept.length} orphan tmux sessions before up: ${swept.join(", ")}\n`);
    }
  } catch { /* best-effort */ }

  if (await isPortBound(7745)) {
    process.stderr.write(`[upCompose] port 7745 still bound — running pre-emptive 'down -v'\n`);
    runCompose(["down", "-v", "--remove-orphans", "-t", "1"], { timeoutMs: 30_000 });
    await waitPortFree(7745, 10_000);
  }

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

  // Tight timeout (1s grace) and --remove-orphans: tests crashing mid-run can
  // leave containers in states that take minutes to drain gracefully; tests
  // don't need that drain.
  let r = runCompose(["down", "-v", "--remove-orphans", "-t", "1"], { timeoutMs: 30_000 });
  if (r.code !== 0) {
    // Race observed: `Container ... Error while Removing` — retry once after
    // a short settle. If still failing, fall through and the next upCompose
    // pre-flight will clean up.
    process.stderr.write(`[downCompose] first 'down -v' failed (code ${r.code}): ${r.stderr}\nretrying after 1s\n`);
    await new Promise((res) => setTimeout(res, 1_000));
    r = runCompose(["down", "-v", "--remove-orphans", "-t", "1"], { timeoutMs: 30_000 });
    if (r.code !== 0) {
      process.stderr.write(`[downCompose] second 'down -v' also failed (code ${r.code}): ${r.stderr}\n`);
    }
  }

  // Block briefly until the published port is no longer bound. Without this,
  // the next scenario's upCompose can hit a transient EADDRINUSE.
  if (!(await waitPortFree(7745, 10_000))) {
    process.stderr.write(`[downCompose] WARNING: port 7745 still bound 10s after 'down -v'\n`);
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
