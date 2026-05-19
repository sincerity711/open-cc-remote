#!/usr/bin/env bun
// In-process fake Claude session — connects directly to the daemon's Unix
// socket, sends a register frame, then idles. Replaces the previous
// "spawn the plugin" approach which is no longer compatible with the
// MCP-only plugin entry point.
//
// Usage:
//   bun tools/fake-claude/fake-claude.ts --session-id s1 --cwd /tmp/fake \
//     [--socket /path/daemon.sock] [--inject-permission Bash:req-1:rm/-rf]

import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { connectDaemon } from "../../packages/plugin/src/daemon-client.ts";
import type { SessionSnapshot } from "@cc-remote/proto";

const args = parseArgs(process.argv.slice(2));

async function main() {
  const sockPath = args.socket ?? process.env.CC_REMOTE_SOCKET ?? join(homedir(), ".cc-remote", "daemon.sock");

  const session: SessionSnapshot = {
    session_id: args["session-id"] ?? randomUUID(),
    claude_session_id: args["claude-session-id"] ?? null,
    tmux_session: args["tmux-session"] || null,
    tmux_pane: args["tmux-pane"] || null,
    cwd: args.cwd ?? process.cwd(),
    model: args.model ?? null,
    pid: process.pid,
    started_at: Math.floor(Date.now() / 1000),
    claude_client_version: "fake-claude",
    plugin_version: "fake",
  };

  const client = await connectDaemon(sockPath, {
    timeoutMs: 3000,
    onClose: () => {
      process.stderr.write(`fake-claude: daemon closed connection, exiting\n`);
      process.exit(0);
    },
  });
  await client.send({ type: "register", session });
  process.stderr.write(`fake-claude: registered ${session.session_id} cwd=${session.cwd}\n`);

  const inj = args["inject-permission"]; // format: tool:request_id:args_summary
  if (inj) {
    const [tool, request_id, ...rest] = inj.split(":");
    const args_summary = rest.join(":");
    setTimeout(() => {
      client.sendOneWay({
        type: "permission_request",
        request_id: request_id ?? `req-${Date.now()}`,
        tool: tool ?? "Bash",
        args_summary: args_summary ?? "",
        expires_at: Date.now() + 60_000,
      });
      process.stderr.write(`fake-claude: injected permission_request ${request_id ?? "auto"}\n`);
    }, 100);
  }

  const goodbye = (code: number) => {
    void client.send({ type: "bye", session_id: session.session_id }).finally(() => {
      client.close();
      process.exit(code);
    });
  };
  process.on("SIGINT", () => goodbye(130));
  process.on("SIGTERM", () => goodbye(143));

  setInterval(() => {}, 1 << 30);
}

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

main().catch((e) => {
  process.stderr.write(`fake-claude: ${(e as Error).message}\n`);
  process.exit(1);
});
