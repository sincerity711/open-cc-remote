import { test, expect } from "bun:test";
import type { Socket } from "node:net";
import type {
  HubToDaemonChatSend,
  PluginChatOut,
  DaemonChatIn,
  DaemonToHub,
} from "@cc-remote/proto";
import { handleHubChatSend, handlePluginChatOut } from "../src/chat.ts";

function fakeSocket(): Socket {
  // Only used as an opaque key — we don't actually write to it via the chat
  // module since replyTo is mocked. Cast through unknown to avoid implementing
  // the full Socket surface.
  return { _fake: true } as unknown as Socket;
}

test("Test A: hub chat_send forwards to plugin as chat_in with matching fields", () => {
  const sock = fakeSocket();
  const sessionToClient = new Map<string, Socket>([["s1", sock]]);
  const writes: Array<{ client: Socket; frame: DaemonChatIn }> = [];
  const router = {
    sessionToClient,
    replyTo(client: Socket, frame: DaemonChatIn) {
      writes.push({ client, frame });
    },
  };

  const frame: HubToDaemonChatSend = {
    type: "chat_send",
    session_id: "s1",
    message_id: "m_01",
    user: "alice@example.com",
    user_id: "sub-123",
    content: "hello claude",
    reply_to: null,
    ts: 1716000000,
  };
  handleHubChatSend(frame, router);

  expect(writes.length).toBe(1);
  expect(writes[0]!.client).toBe(sock);
  expect(writes[0]!.frame).toEqual({
    type: "chat_in",
    session_id: "s1",
    message_id: "m_01",
    user: "alice@example.com",
    user_id: "sub-123",
    content: "hello claude",
    ts: 1716000000,
  });
});

test("Test B: plugin chat_out forwards to hub field-for-field", () => {
  const sent: DaemonToHub[] = [];
  const hub = { send(f: DaemonToHub) { sent.push(f); } };

  const frame: PluginChatOut = {
    type: "chat_out",
    session_id: "s1",
    content: "ack",
    ts: 1716000005,
    reply_to: "m_01",
  };
  handlePluginChatOut(frame, hub);

  expect(sent.length).toBe(1);
  expect(sent[0]).toEqual({
    type: "chat_out",
    session_id: "s1",
    content: "ack",
    ts: 1716000005,
    reply_to: "m_01",
  });
});

test("Test C: hub chat_send for unknown session logs + drops (no crash, no write)", () => {
  const sessionToClient = new Map<string, Socket>();
  const writes: Array<{ client: Socket; frame: DaemonChatIn }> = [];
  const logs: string[] = [];
  const router = {
    sessionToClient,
    replyTo(client: Socket, frame: DaemonChatIn) {
      writes.push({ client, frame });
    },
  };

  const frame: HubToDaemonChatSend = {
    type: "chat_send",
    session_id: "s_ghost",
    message_id: "m_02",
    user: "alice@example.com",
    user_id: "sub-123",
    content: "void",
    reply_to: null,
    ts: 1716000010,
  };
  handleHubChatSend(frame, router, (m) => logs.push(m));

  expect(writes.length).toBe(0);
  expect(logs.length).toBe(1);
  expect(logs[0]).toContain("s_ghost");
  expect(logs[0]).toContain("unknown session");
});
