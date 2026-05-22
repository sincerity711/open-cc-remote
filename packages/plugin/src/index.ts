#!/usr/bin/env bun
import { join } from "node:path";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { InitializeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { connectDaemonReconnecting, type DaemonClient } from "./daemon-client.ts";
import { buildSession } from "./session.ts";
import { installPermissionRelay, emitPermissionDecision } from "./permission.ts";
import { installChatRelay, emitChatIn } from "./chat.ts";
import { installTools } from "./tools.ts";

const INSTRUCTIONS = [
  "The PWA user reads cc-remote, not this session. Anything you want them to see must go through the reply tool — your transcript output never reaches them.",
  "",
  'Messages from the PWA arrive as <channel source="cc-remote" chat_id="pwa" message_id="..." user="..." ts="...">. Reply with the reply tool. Use reply_to (set to a message_id) only when threading; for normal responses, omit reply_to.',
  "",
  "Permission prompts are routed to the PWA. The PWA user authenticates via SAP IAS before they can approve or deny — you can trust the channel.",
].join("\n");

async function main() {
  const pkgPath = join(import.meta.dir, "..", "package.json");
  const pluginVersion = (JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string }).version;

  const sockPath = process.env.CC_REMOTE_SOCKET ?? join(homedir(), ".cc-remote", "daemon.sock");

  let registered = false;
  let mcp: Server | null = null;
  // Hold the SessionSnapshot we registered with so we can re-send it on
  // reconnect. The plugin process outlives any single daemon process now.
  let registeredSession: import("@cc-remote/proto").SessionSnapshot | null = null;

  let daemon: DaemonClient;
  try {
    daemon = await connectDaemonReconnecting(sockPath, {
      initialTimeoutMs: 3000,
      onDisconnected: () => {
        process.stderr.write(`cc-remote plugin: daemon disconnected; will reconnect\n`);
      },
      onReconnecting: (attempt, delayMs) => {
        if (attempt <= 3 || attempt % 5 === 0) {
          process.stderr.write(`cc-remote plugin: reconnect attempt ${attempt} in ${delayMs}ms\n`);
        }
      },
      onReconnected: () => {
        process.stderr.write(`cc-remote plugin: daemon reconnected\n`);
        // Re-send the original register so the new daemon picks up this
        // session. Idempotent on the daemon side: LiveSessions.add no-ops if
        // the session_id already exists; on a fresh daemon process it's a
        // genuine fresh registration.
        if (registeredSession) {
          void daemon.send({ type: "register", session: registeredSession }).catch(() => {});
        }
      },
    });
  } catch (e) {
    process.stderr.write(`cc-remote plugin: cannot reach daemon at ${sockPath}: ${(e as Error).message}\n`);
    process.exit(1);
  }

  mcp = new Server(
    { name: "cc-remote", version: pluginVersion },
    {
      capabilities: {
        tools: {},
        experimental: {
          "claude/channel": {},
          "claude/channel/permission": {},
        },
      },
      instructions: INSTRUCTIONS,
    },
  );

  let pluginSessionId = "";
  let initTimer: ReturnType<typeof setTimeout>;

  mcp.setRequestHandler(InitializeRequestSchema, async (req) => {
    clearTimeout(initTimer);
    const claudeClientVersion = req.params.clientInfo?.version ?? "unknown";

    const session = buildSession({
      env: process.env,
      claudeClientVersion,
      pluginVersion,
      pid: process.pid,
      now: Math.floor(Date.now() / 1000),
    });
    pluginSessionId = session.session_id;

    try {
      await daemon.send({ type: "register", session });
      registered = true;
      registeredSession = session;
      process.stderr.write(`cc-remote plugin: registered ${session.session_id} cwd=${session.cwd}\n`);
    } catch (e) {
      process.stderr.write(`cc-remote plugin: register failed: ${(e as Error).message}\n`);
      process.exit(1);
    }

    installPermissionRelay({ mcp: mcp!, daemon, pluginSessionId });
    installChatRelay({ mcp: mcp!, daemon, pluginSessionId });
    installTools(mcp!);

    daemon.onFrame((f) => {
      if (f.type === "permission_reply") {
        emitPermissionDecision(mcp!, f.request_id, f.decision);
      } else if (f.type === "chat_in") {
        emitChatIn(mcp!, f);
      } else if (f.type === "daemon_going_down") {
        process.stderr.write(`cc-remote plugin: daemon going down (${f.reason}); waiting to reconnect\n`);
      }
    });

    return {
      protocolVersion: req.params.protocolVersion ?? "2024-11-05",
      capabilities: {
        tools: {},
        experimental: {
          "claude/channel": {},
          "claude/channel/permission": {},
        },
      },
      serverInfo: { name: "cc-remote", version: pluginVersion },
      instructions: INSTRUCTIONS,
    };
  });

  const goodbye = async (code: number) => {
    if (registered) {
      try {
        await Promise.race([
          daemon.send({ type: "bye", session_id: pluginSessionId }),
          new Promise((r) => setTimeout(r, 500)),
        ]);
      } catch {}
    }
    daemon.close();
    process.exit(code);
  };

  process.on("SIGINT", () => goodbye(130));
  process.on("SIGTERM", () => goodbye(143));

  initTimer = setTimeout(() => {
    process.stderr.write(`cc-remote plugin: MCP initialize did not arrive within 5s; exiting\n`);
    process.exit(1);
  }, 5000);

  await mcp.connect(new StdioServerTransport());
}

main().catch((e) => {
  process.stderr.write(`cc-remote plugin fatal: ${(e as Error).message}\n`);
  process.exit(1);
});
