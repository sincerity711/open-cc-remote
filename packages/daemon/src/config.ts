import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface DaemonConfig {
  daemon_id: string;
  hub_url: string;
  state_dir: string;
  socket_path: string;
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
  const data = JSON.parse(raw) as { daemon_id?: string; hub_url?: string };
  if (!data.daemon_id) throw new Error(`config.json missing daemon_id`);
  if (!data.hub_url) throw new Error(`config.json missing hub_url`);
  return {
    daemon_id: data.daemon_id,
    hub_url: data.hub_url,
    state_dir: stateDir,
    socket_path: join(stateDir, "daemon.sock"),
  };
}
