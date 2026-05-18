#!/usr/bin/env bun
// Simulates a Claude Code session by spawning the plugin with the env vars
// Claude Code would set, then idling until killed.
//
// Usage:
//   bun tools/fake-claude/fake-claude.ts --session-id s1 --cwd /tmp/fake \
//     [--model opus-4.7] [--tmux-session work] [--socket /path/daemon.sock]

import { spawn } from "node:child_process";
import { resolve } from "node:path";

const args = parseArgs(process.argv.slice(2));
const pluginPath = resolve(import.meta.dir, "..", "..", "packages", "plugin", "src", "index.ts");

const child = spawn("bun", [pluginPath], {
  stdio: ["pipe", "inherit", "inherit"],
  env: {
    ...process.env,
    CLAUDE_SESSION_ID: args["session-id"] ?? `s_${Date.now()}`,
    CLAUDE_PROJECT_DIR: args.cwd ?? process.cwd(),
    CLAUDE_MODEL: args.model ?? "claude-sonnet-4-6",
    TMUX_SESSION: args["tmux-session"] ?? "",
    TMUX_PANE: args["tmux-pane"] ?? "",
    ...(args.socket ? { CC_REMOTE_SOCKET: args.socket } : {}),
  },
});

const shutdown = () => { child.stdin.end(); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

child.on("exit", (code) => process.exit(code ?? 0));

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const cur = argv[i]!;
    if (cur.startsWith("--")) {
      const key = cur.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) { out[key] = next; i++; } else { out[key] = "true"; }
    }
  }
  return out;
}
