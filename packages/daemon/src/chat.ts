import type { Socket } from "node:net";
import type {
  HubToDaemonChatSend,
  PluginChatOut,
  DaemonChatIn,
  DaemonToHub,
} from "@cc-remote/proto";

export interface ChatPluginRouter {
  sessionToClient: Map<string, Socket>;
  replyTo(client: Socket, frame: DaemonChatIn): void;
}

export interface ChatHubSender {
  send(frame: DaemonToHub): void;
}

/**
 * Translate a hub-issued chat_send into a plugin chat_in frame and write to the
 * plugin's Unix socket for the target session. If the session is unknown,
 * stderr-log and drop the frame (no crash).
 */
export function handleHubChatSend(
  frame: HubToDaemonChatSend,
  router: ChatPluginRouter,
  log: (msg: string) => void = (m) => process.stderr.write(m),
): void {
  const client = router.sessionToClient.get(frame.session_id);
  if (!client) {
    log(`daemon: chat_send for unknown session ${frame.session_id} (dropped)\n`);
    return;
  }
  const out: DaemonChatIn = {
    type: "chat_in",
    session_id: frame.session_id,
    message_id: frame.message_id,
    user: frame.user,
    user_id: frame.user_id,
    content: frame.content,
    ts: frame.ts,
  };
  router.replyTo(client, out);
}

/**
 * Forward a plugin chat_out frame to the hub. Field-for-field pass-through;
 * the hub generates message_id and broadcasts.
 */
export function handlePluginChatOut(
  frame: PluginChatOut,
  hub: ChatHubSender,
): void {
  hub.send({
    type: "chat_out",
    session_id: frame.session_id,
    content: frame.content,
    ts: frame.ts,
    reply_to: frame.reply_to,
  });
}
