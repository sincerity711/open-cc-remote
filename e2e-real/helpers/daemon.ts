// Daemon lifecycle helper for e2e-real tests.
//
// Each scenario gets its own state dir (mkdtemp) so daemons are fully isolated.
// `startDaemon` writes a `config.json` with the requested options, spawns
// `bun run packages/daemon/src/index.ts`, and waits for the "ready" line.
// `pairDaemon` invokes the `cc-remote pair` CLI against a real hub.
//
// `mkStateDirSync` is exported so tests can pre-allocate a state dir, pair
// into it (which writes state.json + keystore), then start the paired daemon.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const daemonEntry = join(repoRoot, "packages", "daemon", "src", "index.ts");
const ccRemoteCli = join(repoRoot, "packages", "daemon", "bin", "cc-remote.ts");

export function mkStateDir(daemon_id: string): string {
  return mkdtempSync(join(tmpdir(), `ccr-daemon-${daemon_id}-`));
}

export function rmStateDir(state_dir: string): void {
  try { rmSync(state_dir, { recursive: true, force: true }); } catch {}
}

export interface DaemonOpts {
  daemon_id: string;
  hub_url: string;
  allow_kill?: boolean;
  allow_start?: boolean;
  allowed_cwd_prefix?: string[];
  spawn_command?: string;
  idle_window_ms?: number;
  /** Reuse an existing state dir (e.g. from a prior pair step). If unset, a
   * fresh tmpdir is allocated. */
  state_dir?: string;
  /** When true, `stop()` will NOT delete the state dir on shutdown — useful
   * for the pair → restart pattern where state.json must survive. Defaults
   * to false when state_dir is owned by us, true when state_dir is supplied
   * by the caller. */
  preserve_state_on_stop?: boolean;
}

export interface DaemonHandle {
  daemon_id: string;
  state_dir: string;
  socket_path: string;
  proc: ChildProcess;
  stderr(): string;
  stdout(): string;
  stop(): Promise<void>;
}

function ensureStateDir(daemon_id: string): string {
  return mkdtempSync(join(tmpdir(), `ccr-daemon-${daemon_id}-`));
}

function writeConfig(state_dir: string, opts: DaemonOpts): void {
  mkdirSync(state_dir, { recursive: true, mode: 0o700 });
  const cfg: Record<string, unknown> = {
    daemon_id: opts.daemon_id,
    hub_url: opts.hub_url,
  };
  if (opts.allow_kill !== undefined) cfg.allow_kill = opts.allow_kill;
  if (opts.allow_start !== undefined) cfg.allow_start = opts.allow_start;
  if (opts.allowed_cwd_prefix !== undefined) cfg.allowed_cwd_prefix = opts.allowed_cwd_prefix;
  if (opts.spawn_command !== undefined) cfg.spawn_command = opts.spawn_command;
  if (opts.idle_window_ms !== undefined) cfg.idle_window_ms = opts.idle_window_ms;
  writeFileSync(join(state_dir, "config.json"), JSON.stringify(cfg, null, 2) + "\n");
}

export async function startDaemon(opts: DaemonOpts): Promise<DaemonHandle> {
  const state_dir = opts.state_dir ?? ensureStateDir(opts.daemon_id);
  writeConfig(state_dir, opts);

  const env = { ...process.env, CC_REMOTE_STATE_DIR: state_dir };
  const proc = spawn("bun", ["run", daemonEntry], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdoutBuf = "";
  let stderrBuf = "";
  proc.stdout?.on("data", (chunk) => { stdoutBuf += chunk.toString(); });
  proc.stderr?.on("data", (chunk) => { stderrBuf += chunk.toString(); });

  // Wait for "ready" in stdout or stderr.
  const ready = await new Promise<boolean>((resolveReady) => {
    const deadline = Date.now() + 8_000;
    const t = setInterval(() => {
      if (stdoutBuf.includes("ready") || stderrBuf.includes("ready")) {
        clearInterval(t);
        resolveReady(true);
      } else if (Date.now() > deadline || proc.exitCode !== null) {
        clearInterval(t);
        resolveReady(false);
      }
    }, 100);
  });

  if (!ready) {
    try { proc.kill("SIGKILL"); } catch {}
    rmSync(state_dir, { recursive: true, force: true });
    throw new Error(
      `daemon ${opts.daemon_id} did not become ready in 8s\n` +
      `state_dir=${state_dir}\n` +
      `stderr:\n${stderrBuf}\nstdout:\n${stdoutBuf}`,
    );
  }

  const handle: DaemonHandle = {
    daemon_id: opts.daemon_id,
    state_dir,
    socket_path: join(state_dir, "daemon.sock"),
    proc,
    stderr: () => stderrBuf,
    stdout: () => stdoutBuf,
    async stop() {
      if (proc.exitCode === null) {
        proc.kill("SIGTERM");
        await new Promise<void>((res) => {
          const to = setTimeout(() => {
            try { proc.kill("SIGKILL"); } catch {}
            res();
          }, 3_000);
          proc.once("exit", () => { clearTimeout(to); res(); });
        });
      }
      // Cleanup state dir only if we own it AND the caller didn't ask us to
      // preserve it (e.g. for the pair → restart-paired pattern).
      const ownsDir = opts.state_dir === undefined;
      const preserve = opts.preserve_state_on_stop ?? !ownsDir;
      if (ownsDir && !preserve) {
        try { rmSync(state_dir, { recursive: true, force: true }); } catch {}
      }
    },
  };

  return handle;
}

export interface PairOpts {
  state_dir: string;
  hub_url: string;
  code: string;
  daemon_id: string;
}

export function pairDaemon(opts: PairOpts): void {
  const env = { ...process.env, CC_REMOTE_STATE_DIR: opts.state_dir };
  const r = spawnSync(
    "bun",
    [
      "run", ccRemoteCli, "pair",
      "--hub", opts.hub_url,
      "--code", opts.code,
      "--daemon-id", opts.daemon_id,
    ],
    { env, encoding: "utf8", timeout: 30_000 },
  );
  if ((r.status ?? -1) !== 0) {
    throw new Error(
      `cc-remote pair failed (code ${r.status}):\n` +
      `stderr:\n${r.stderr ?? ""}\nstdout:\n${r.stdout ?? ""}`,
    );
  }
}
