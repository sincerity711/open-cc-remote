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
import { mkdirSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { connectDaemon } from "../../packages/plugin/src/daemon-client.ts";
import { jsonlPath } from "../../packages/daemon/src/jsonl-paths.ts";
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
    state: "idle",
  };

  // --jsonl-mirror: when set, fake-claude maintains a JSONL transcript at the
  // same path the daemon's bindJsonl will discover (CLAUDE_PROJECTS_DIR is
  // honored). On chat_in we append a channel-wrapped user line (mirroring
  // real Claude's behavior); on auto-reply we append an assistant text line.
  // Without this, mock-driven scenarios that only exercise the chat path see
  // an empty timeline because (since 81862c0) chat broadcasts are no longer
  // a render source — JSONL is.
  const jsonlMirror = args["jsonl-mirror"] === "true";
  const claudeId = session.claude_session_id ?? session.session_id;
  const transcriptPath = jsonlPath(session.cwd, claudeId);
  if (jsonlMirror) {
    mkdirSync(join(transcriptPath, ".."), { recursive: true });
    if (!existsSync(transcriptPath)) writeFileSync(transcriptPath, "");
    process.stderr.write(`fake-claude: jsonl mirror at ${transcriptPath}\n`);
  }

  const client = await connectDaemon(sockPath, {
    timeoutMs: 3000,
    onClose: () => {
      process.stderr.write(`fake-claude: daemon closed connection, exiting\n`);
      process.exit(0);
    },
  });
  await client.send({ type: "register", session });
  process.stderr.write(`fake-claude: registered ${session.session_id} cwd=${session.cwd}\n`);

  // --auto-reply <text>: when this fake-claude receives a chat_in from the
  // daemon, immediately emit a chat_out with `content: text`. Used by the
  // chat round-trip e2e tests.
  const autoReply = args["auto-reply"];
  if (autoReply || jsonlMirror) {
    client.onFrame((frame) => {
      if (frame.type !== "chat_in") return;
      if (jsonlMirror) {
        appendUserChannelLine(transcriptPath, claudeId, session.cwd, frame);
        // Tiny delay so the user line settles in the timeline before the
        // assistant reply lands — mirrors real Claude's pacing and avoids
        // both lines arriving at the same ms (mergeTimeline rank tiebreak).
        setTimeout(() => {
          if (autoReply) appendAssistantLine(transcriptPath, claudeId, session.cwd, autoReply);
        }, 30);
      }
      if (autoReply) {
        client.sendOneWay({
          type: "chat_out",
          session_id: session.session_id,
          content: autoReply,
          ts: Math.floor(Date.now() / 1000),
          reply_to: frame.message_id,
        });
        process.stderr.write(`fake-claude: chat_in received → emitted chat_out "${autoReply}"\n`);
      }
    });
  }

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

// ─── JSONL mirroring helpers ─────────────────────────────────────────────

interface ChatInFrame {
  message_id: string;
  user: string;
  user_id: string;
  content: string;
  ts: number;
}

function appendUserChannelLine(path: string, sessionId: string, cwd: string, frame: ChatInFrame): void {
  const tsIso = new Date(frame.ts * 1000).toISOString();
  const envelope =
    `<channel source="cc-remote" chat_id="pwa" message_id="${frame.message_id}" ` +
    `user="${frame.user}" user_id="${frame.user_id}" ts="${tsIso}">\n${frame.content}\n</channel>`;
  const line = {
    parentUuid: null,
    isSidechain: false,
    promptId: `prompt-${frame.message_id}`,
    type: "user",
    message: { role: "user", content: envelope },
    isMeta: true,
    uuid: `u-${frame.message_id}`,
    timestamp: tsIso,
    permissionMode: "default",
    origin: { kind: "channel", server: "cc-remote" },
    userType: "external",
    entrypoint: "cli",
    cwd,
    sessionId,
    version: "fake-claude",
    gitBranch: "HEAD",
  };
  appendFileSync(path, `${JSON.stringify(line)}\n`);
}

function appendAssistantLine(path: string, sessionId: string, cwd: string, text: string): void {
  const tsIso = new Date().toISOString();
  const line = {
    parentUuid: null,
    isSidechain: false,
    message: {
      model: "fake-claude",
      id: `msg-${Date.now()}`,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: text.length, service_tier: "standard" },
    },
    type: "assistant",
    uuid: `a-${Date.now()}`,
    timestamp: tsIso,
    userType: "external",
    entrypoint: "cli",
    cwd,
    sessionId,
    version: "fake-claude",
    gitBranch: "HEAD",
  };
  appendFileSync(path, `${JSON.stringify(line)}\n`);
}
