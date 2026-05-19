#!/usr/bin/env bun
import { join } from "node:path";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { InitializeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { connectDaemon } from "./daemon-client.ts";
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
  let daemon;
  try {
    daemon = await connectDaemon(sockPath, { timeoutMs: 3000 });
  } catch (e) {
    process.stderr.write(`cc-remote plugin: cannot reach daemon at ${sockPath}: ${(e as Error).message}\n`);
    process.exit(1);
  }

  const mcp = new Server(
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

  let registered = false;
  let pluginSessionId = "";

  mcp.setRequestHandler(InitializeRequestSchema, async (req) => {
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
      process.stderr.write(`cc-remote plugin: registered ${session.session_id} cwd=${session.cwd}\n`);
    } catch (e) {
      process.stderr.write(`cc-remote plugin: register failed: ${(e as Error).message}\n`);
      process.exit(1);
    }

    installPermissionRelay({ mcp, daemon, pluginSessionId });
    installChatRelay({ mcp, daemon, pluginSessionId });
    installTools(mcp);

    daemon.onFrame((f) => {
      if (f.type === "permission_reply") {
        emitPermissionDecision(mcp, f.request_id, f.decision);
      } else if (f.type === "chat_in") {
        emitChatIn(mcp, f);
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

  await mcp.connect(new StdioServerTransport());
}

main().catch((e) => {
  process.stderr.write(`cc-remote plugin fatal: ${(e as Error).message}\n`);
  process.exit(1);
});
