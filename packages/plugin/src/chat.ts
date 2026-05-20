import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { DaemonClient } from "./daemon-client.ts";

export interface ChatRelayDeps {
  mcp: Server;
  daemon: DaemonClient;
  pluginSessionId: string;
}

export function installChatRelay({ mcp, daemon, pluginSessionId }: ChatRelayDeps): void {
  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name !== "reply") {
      throw new Error(`unknown tool: ${req.params.name}`);
    }
    const args = req.params.arguments ?? {};
    const text = typeof args.text === "string" ? args.text : "";
    if (!text) throw new Error("reply: 'text' is required and must be a non-empty string");
    const reply_to = typeof args.reply_to === "string" ? args.reply_to : null;

    try {
      await daemon.send({
        type: "chat_out",
        session_id: pluginSessionId,
        content: text,
        ts: Math.floor(Date.now() / 1000),
        reply_to,
      });
    } catch (e) {
      throw new Error(`reply failed: cc-remote daemon write error: ${(e as Error).message}`);
    }

    return { content: [{ type: "text", text: "delivered" }] };
  });
}

// Called by index.ts when a chat_in frame arrives on the daemon socket
export function emitChatIn(mcp: Server, frame: { message_id: string; user: string; user_id: string; content: string; ts: number }): void {
  // Claude Code's Zod schema for `notifications/claude/channel` requires
  // `meta.ts` to be a STRING (ISO 8601). The daemon sends ts as unix
  // seconds (number); convert here. Without this, claude silently drops
  // the notification with a Zod "expected string, received number" error
  // and the channel content never reaches the model — channel relay
  // appears completely broken from the user's perspective.
  const tsIso = new Date(frame.ts * 1000).toISOString();
  void mcp.notification({
    method: "notifications/claude/channel",
    params: {
      content: frame.content,
      meta: {
        chat_id: "pwa",
        message_id: frame.message_id,
        user: frame.user,
        user_id: frame.user_id,
        ts: tsIso,
      },
    },
  });
}
