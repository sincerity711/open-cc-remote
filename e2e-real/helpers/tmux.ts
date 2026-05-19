// Low-level tmux primitives used by the e2e-real claude harness.
//
// All commands shell out to the host `tmux` binary; failures throw with
// captured stderr so callers can include them in diagnostic messages.

import { spawnSync } from "node:child_process";

function run(args: string[], opts: { ignoreFailure?: boolean } = {}): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("tmux", args, { encoding: "utf8" });
  const code = r.status ?? -1;
  if (code !== 0 && !opts.ignoreFailure) {
    throw new Error(
      `tmux ${args.join(" ")} failed (code ${code}): ${r.stderr ?? ""}`.trim(),
    );
  }
  return { code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export function newSession(name: string, cwd: string): void {
  run(["new-session", "-d", "-s", name, "-c", cwd, "-x", "200", "-y", "50"]);
}

export function sendKeys(name: string, text: string, withEnter = true): void {
  // tmux send-keys quotes its own arg list — pass text as-is.
  if (withEnter) {
    run(["send-keys", "-t", name, text, "Enter"]);
  } else {
    run(["send-keys", "-t", name, text]);
  }
}

export function sendEnter(name: string): void {
  run(["send-keys", "-t", name, "Enter"]);
}

export function capturePane(name: string): string {
  const r = run(["capture-pane", "-t", name, "-p"]);
  return r.stdout;
}

export function hasSession(name: string): boolean {
  const r = run(["has-session", "-t", name], { ignoreFailure: true });
  return r.code === 0;
}

export function killSession(name: string): void {
  run(["kill-session", "-t", name], { ignoreFailure: true });
}

export function listCcrSessions(): string[] {
  const r = run(["list-sessions", "-F", "#S"], { ignoreFailure: true });
  if (r.code !== 0) return [];
  return r.stdout.split("\n").filter((n) => n.startsWith("ccr-"));
}

export async function waitForPattern(
  name: string,
  re: RegExp,
  timeoutMs: number,
  label: string,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    last = capturePane(name);
    if (re.test(last)) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `tmux waitForPattern timed out after ${timeoutMs}ms\n` +
    `  session: ${name}\n` +
    `  label:   ${label}\n` +
    `  pattern: ${re}\n` +
    `  --- last capture-pane ---\n${last}\n  ---`,
  );
}
