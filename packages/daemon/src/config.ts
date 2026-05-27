import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface DaemonConfig {
  daemon_id: string;
  hub_url: string;
  state_dir: string;
  socket_path: string;
  state_path: string;
  allow_kill: boolean;
  allow_start: boolean;
  allowed_cwd_prefix: string[];
  /**
   * Required when `allow_start=true`. `cc-remote init` writes a working
   * default (`claude --mcp-config <state>/mcp-config.json
   * --dangerously-load-development-channels server:cc-remote`) so a paired
   * daemon can spawn sessions out of the box. start_session rejects with
   * reason `spawn_command_unset` if this is missing — surfaced to the PWA via
   * the start_session_rejected frame.
   */
  spawn_command: string | undefined;
  idle_window_ms: number;
}

export function defaultStateDir(): string {
  return process.env.CC_REMOTE_STATE_DIR ?? join(homedir(), ".cc-remote");
}

export function loadConfig(stateDir: string = defaultStateDir()): DaemonConfig {
  const path = join(stateDir, "config.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`could not read ${path}: ${(e as Error).message}`);
  }
  const data = JSON.parse(raw) as {
    daemon_id?: string; hub_url?: string; allow_kill?: boolean;
    allow_start?: boolean; allowed_cwd_prefix?: string[]; spawn_command?: string;
    idle_window_ms?: number;
  };
  if (!data.daemon_id) throw new Error(`config.json missing daemon_id`);
  if (!data.hub_url) throw new Error(`config.json missing hub_url`);
  return {
    daemon_id: data.daemon_id,
    hub_url: data.hub_url,
    state_dir: stateDir,
    socket_path: join(stateDir, "daemon.sock"),
    state_path: join(stateDir, "state.json"),
    allow_kill: data.allow_kill === true,
    allow_start: data.allow_start === true,
    allowed_cwd_prefix: data.allowed_cwd_prefix ?? [],
    spawn_command: typeof data.spawn_command === "string" && data.spawn_command.length > 0
      ? data.spawn_command
      : undefined,
    idle_window_ms: typeof data.idle_window_ms === "number" ? data.idle_window_ms : 30_000,
  };
}
