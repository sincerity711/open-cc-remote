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
  let goodbyeSent = false;
  try {
    client = await connectDaemon(sockPath, {
      timeoutMs: 3000,
      onClose: () => {
        // Daemon dropped the connection (e.g., kill_session). Exit cleanly.
        if (!goodbyeSent) {
          process.stderr.write(`cc-remote plugin: daemon closed connection, exiting\n`);
          process.exit(0);
        }
      },
    });
  } catch (e) {
    process.stderr.write(`cc-remote plugin: cannot reach daemon at ${sockPath}: ${(e as Error).message}\n`);
    process.exit(0);
  }

  const session = buildSession();
  await client.send({ type: "register", session });
  process.stderr.write(`cc-remote plugin: registered session ${session.session_id}\n`);

  // Test hook: emit a fake permission_request when env var is set.
  const fakeTool = process.env.CC_REMOTE_FAKE_PERMISSION;
  if (fakeTool) {
    const requestId = process.env.CC_REMOTE_FAKE_REQUEST_ID ?? `req-${Date.now()}`;
    const argsSummary = process.env.CC_REMOTE_FAKE_ARGS ?? `(test) ${fakeTool}`;
    setTimeout(() => {
      client.sendOneWay({
        type: "permission_request",
        request_id: requestId,
        tool: fakeTool,
        args_summary: argsSummary,
        expires_at: Date.now() + 60_000,
      });
      process.stderr.write(`cc-remote plugin: sent fake permission_request ${requestId}\n`);
    }, 100);
  }

  const goodbye = async (code: number) => {
    goodbyeSent = true;
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

  process.stdin.resume();
}

main().catch((e) => {
  process.stderr.write(`cc-remote plugin: ${(e as Error).message}\n`);
  process.exit(1);
});
