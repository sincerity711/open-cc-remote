// Login-shell helpers for capturing what an interactive user would see in
// PATH and where their CLIs live.
//
// Why this exists: systemd user units, launchd, sshd's non-interactive shells,
// and even bun's child_process.spawn don't source ~/.bashrc / ~/.zshrc / their
// shell's rc-equivalent. So when a daemon (started by systemd) tries to spawn
// `claude` via tmux, PATH is the systemd-stripped one and `claude` is missing
// — even though the user can run `claude` fine in their own terminal.
//
// We resolve this at *configuration* time (init / install) — when a real human
// is on the keyboard — and bake the result into the file we write. No login
// shell ever runs in the daemon hot path.

import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";

const SHELL_CANDIDATES = ["bash", "zsh", "sh"] as const;

interface LoginShellResult {
  shell: string;
  output: string;
}

/**
 * Run a command inside a *login* invocation of one of bash/zsh/sh and return
 * the trimmed stdout. We try bash first (covers the vast majority of users),
 * then zsh (macOS default), then sh (POSIX fallback). A failing shell is
 * skipped — only an actually-empty result returns null.
 *
 * Pure (no module-level cache) so callers can dependency-inject behaviour in
 * tests by overriding spawnSync via the optional second argument.
 */
export function runInLoginShell(
  cmd: string,
  spawn: typeof spawnSync = spawnSync,
): LoginShellResult | null {
  const opts: SpawnSyncOptionsWithStringEncoding = {
    encoding: "utf8",
    timeout: 3000,
    stdio: ["ignore", "pipe", "pipe"],
  };
  for (const shell of SHELL_CANDIDATES) {
    let r;
    try { r = spawn(shell, ["-lc", cmd], opts); }
    catch { continue; }
    if (r.error) continue;            // shell not on PATH at all
    if (r.status !== 0) continue;     // shell ran but the command failed
    const output = (r.stdout ?? "").trim();
    if (output) return { shell, output };
  }
  return null;
}

/**
 * Resolve a binary name (e.g. `claude`) to an absolute path, as a real
 * interactive shell would. Returns null when no login shell can find it
 * (binary genuinely missing, or no usable shell on the box).
 */
export function resolveBinaryViaLoginShell(
  name: string,
  spawn: typeof spawnSync = spawnSync,
): string | null {
  // `command -v` is POSIX and deliberately portable across bash/zsh/sh.
  // Bare name only — never let a user-controlled argument reach the shell.
  if (!/^[A-Za-z0-9._+-]+$/.test(name)) return null;
  const r = runInLoginShell(`command -v ${name}`, spawn);
  if (!r) return null;
  // command -v can echo a shell builtin/alias; treat anything that's not an
  // absolute path as "not actually a binary".
  return r.output.startsWith("/") ? r.output : null;
}

/**
 * Capture the user's interactive PATH. Useful for systemd / launchd unit
 * files so the daemon (and everything it spawns: tmux, claude, git, hooks)
 * sees the same PATH the user does in their terminal.
 *
 * Returns null if no login shell could be invoked. Callers should fall back
 * to a sane built-in PATH in that case.
 */
export function loginShellPath(spawn: typeof spawnSync = spawnSync): string | null {
  const r = runInLoginShell("printf %s \"$PATH\"", spawn);
  return r?.output ?? null;
}
