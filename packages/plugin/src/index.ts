#!/usr/bin/env bun
import { join } from "node:path";
import { homedir } from "node:os";
import type { SessionSnapshot } from "@cc-remote/proto";
import { connectDaemon, type DaemonClient } from "./daemon-client.ts";

function envOr(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function buildSession(): SessionSnapshot {
  return {
    session_id: envOr("CLAUDE_SESSION_ID", `unknown-${process.pid}`),
    tmux_session: process.env.TMUX_SESSION ?? null,
    tmux_pane: process.env.TMUX_PANE ?? null,
    cwd: envOr("CLAUDE_PROJECT_DIR", process.cwd()),
    model: envOr("CLAUDE_MODEL", "unknown"),
    pid: process.pid,
    started_at: Math.floor(Date.now() / 1000),
  };
}

async function main() {
  const sockPath = process.env.CC_REMOTE_SOCKET ?? join(homedir(), ".cc-remote", "daemon.sock");
  let client: DaemonClient;
  try {
    client = await connectDaemon(sockPath, 3000);
  } catch (e) {
    process.stderr.write(`cc-remote plugin: cannot reach daemon at ${sockPath}: ${(e as Error).message}\n`);
    // Plan 1: exit cleanly so Claude Code is unaffected.
    process.exit(0);
  }

  const session = buildSession();
  await client.send({ type: "register", session });
  process.stderr.write(`cc-remote plugin: registered session ${session.session_id}\n`);

  const goodbye = async (code: number) => {
    try {
      await Promise.race([
        client.send({ type: "bye", session_id: session.session_id }),
        new Promise((r) => setTimeout(r, 500)),
      ]);
    } catch {}
    client.close();
    process.exit(code);
  };

  process.stdin.on("end", () => goodbye(0));
  process.on("SIGINT", () => goodbye(130));
  process.on("SIGTERM", () => goodbye(143));

  // Keep the event loop alive: read stdin (Claude Code uses stdio for MCP framing
  // in real plugins; we ignore it for Plan 1).
  process.stdin.resume();
}

main().catch((e) => {
  process.stderr.write(`cc-remote plugin: ${(e as Error).message}\n`);
  process.exit(1);
});
