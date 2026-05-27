import { join } from "node:path";
import { homedir as defaultHomedir } from "node:os";
import { mkdirSync as defaultMkdir } from "node:fs";
import type { StartSessionRejectReason } from "@cc-remote/proto";

export interface StartSessionConfig {
  allow_start: boolean;
  allowed_cwd_prefix: string[];
  spawn_command: string | undefined;
}

export type StartSessionPrecheck =
  | { ok: true; cwd: string }
  | { ok: false; reason: StartSessionRejectReason; message: string; cwd: string };

export interface PrecheckDeps {
  homedir?: () => string;
  mkdirSync?: (p: string, opts: { recursive: true }) => void;
}

/**
 * Pure(ish) pre-check for start_session. Validates allow_start,
 * allowed_cwd_prefix, spawn_command, expands `~`, and ensures the cwd exists
 * (mkdir -p, gated by the prefix check). On any failure returns a structured
 * reject reason that the daemon caller forwards to the hub as
 * start_session_rejected.
 *
 * `mkdirSync` and `homedir` are injectable so tests can avoid touching the
 * real filesystem and HOME.
 */
export function precheckStartSession(
  raw: { cwd: string },
  cfg: StartSessionConfig,
  deps: PrecheckDeps = {},
): StartSessionPrecheck {
  const homedir = deps.homedir ?? defaultHomedir;
  const mkdirSync = deps.mkdirSync ?? defaultMkdir;

  if (!cfg.allow_start) {
    return { ok: false, reason: "not_allowed", message: "allow_start=false in config", cwd: raw.cwd };
  }
  let cwd = raw.cwd;
  if (cwd === "~") cwd = homedir();
  else if (cwd.startsWith("~/")) cwd = join(homedir(), cwd.slice(2));
  const allowed = cfg.allowed_cwd_prefix.some((p) => cwd.startsWith(p));
  if (!allowed) {
    return {
      ok: false,
      reason: "cwd_not_allowed",
      message: `cwd ${cwd} not in allowed_cwd_prefix`,
      cwd,
    };
  }
  if (!cfg.spawn_command) {
    return {
      ok: false,
      reason: "spawn_command_unset",
      message: "spawn_command not configured; set it in config.json",
      cwd,
    };
  }
  try {
    mkdirSync(cwd, { recursive: true });
  } catch (e) {
    return {
      ok: false,
      reason: "mkdir_failed",
      message: `mkdir ${cwd}: ${(e as Error).message}`,
      cwd,
    };
  }
  return { ok: true, cwd };
}
