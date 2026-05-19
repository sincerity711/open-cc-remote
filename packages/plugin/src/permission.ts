import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { z } from "zod";
import type { DaemonClient } from "./daemon-client.ts";

const PermissionRequestNotification = z.object({
  method: z.literal("notifications/claude/channel/permission_request") as any,
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});

export interface PermissionRelayDeps {
  mcp: Server;
  daemon: DaemonClient;
  pluginSessionId: string;
}

// MCP SDK's TypeScript types don't extend NotificationSchema for custom
// experimental methods like notifications/claude/channel/permission_request,
// so we cast to suppress the schema check. The runtime z.object validates
// the params shape correctly.
export function installPermissionRelay({ mcp, daemon, pluginSessionId }: PermissionRelayDeps): void {
  // CC → plugin: permission_request → daemon
  mcp.setNotificationHandler(PermissionRequestNotification as any, async ({ params }) => {
    try {
      daemon.sendOneWay({
        type: "permission_request",
        request_id: params.request_id,
        tool: params.tool_name,
        args_summary: params.input_preview || params.description,
        expires_at: Date.now() + 5 * 60_000,
      });
    } catch (e) {
      // Daemon write failed — fail-closed by emitting deny back to CC
      process.stderr.write(`cc-remote plugin: forwarding permission_request to daemon failed: ${(e as Error).message}\n`);
      void mcp.notification({
        method: "notifications/claude/channel/permission",
        params: { request_id: params.request_id, behavior: "deny" },
      });
    }
  });
}

// Daemon → CC: invoked by index.ts when a permission_reply frame arrives on the daemon socket
export function emitPermissionDecision(mcp: Server, request_id: string, decision: "allow" | "deny"): void {
  void mcp.notification({
    method: "notifications/claude/channel/permission",
    params: { request_id, behavior: decision },
  });
}
