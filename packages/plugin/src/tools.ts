import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export function installTools(mcp: Server): void {
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "reply",
        description:
          "Send a message to the cc-remote PWA. Pass reply_to (a message_id) for threading; for normal responses omit reply_to.",
        inputSchema: {
          type: "object" as const,
          properties: {
            text: { type: "string" as const, description: "The message to deliver to the PWA user" },
            reply_to: { type: "string" as const, description: "Optional message_id to thread under" },
          },
          required: ["text"],
        },
      },
    ],
  }));
}
