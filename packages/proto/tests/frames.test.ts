import { test, expect } from "bun:test";
import type {
  PwaToHub,
  HubToDaemon,
  HubToPwa,
  DaemonToHub,
  PwaToHubChatSend,
  HubToDaemonChatSend,
  PwaChatBroadcast,
  HubChatErrorBroadcast,
  PluginChatOut,
} from "../src/frames.ts";

// ─── PwaToHubChatSend ─────────────────────────────────────────────────
test("PwaToHubChatSend: round-trip JSON narrowing", () => {
  const f: PwaToHubChatSend = {
    type: "chat_send",
    daemon_id: "d1",
    session_id: "s1",
    content: "hello",
    reply_to: "m_prev",
  };
  const parsed = JSON.parse(JSON.stringify(f)) as PwaToHub;
  expect(parsed.type).toBe("chat_send");
  if (parsed.type === "chat_send") {
    expect(parsed.daemon_id).toBe("d1");
    expect(parsed.session_id).toBe("s1");
    expect(parsed.content).toBe("hello");
    expect(parsed.reply_to).toBe("m_prev");
  }
});

test("PwaToHubChatSend: reply_to is optional", () => {
  const f: PwaToHubChatSend = {
    type: "chat_send",
    daemon_id: "d1",
    session_id: "s1",
    content: "hi",
  };
  expect(f.reply_to).toBeUndefined();
});

// ─── HubToDaemonChatSend ──────────────────────────────────────────────
test("HubToDaemonChatSend: round-trip JSON narrowing", () => {
  const f: HubToDaemonChatSend = {
    type: "chat_send",
    session_id: "s1",
    message_id: "01HXY",
    user: "alice@example.com",
    user_id: "sub-123",
    content: "hi",
    reply_to: null,
    ts: 1716000000,
  };
  const parsed = JSON.parse(JSON.stringify(f)) as HubToDaemon;
  expect(parsed.type).toBe("chat_send");
  if (parsed.type === "chat_send") {
    expect(parsed.message_id).toBe("01HXY");
    expect(parsed.user).toBe("alice@example.com");
    expect(parsed.user_id).toBe("sub-123");
    expect(parsed.reply_to).toBeNull();
    expect(parsed.ts).toBe(1716000000);
  }
});

// ─── PwaChatBroadcast ─────────────────────────────────────────────────
test("PwaChatBroadcast: from=pwa narrows", () => {
  const f: PwaChatBroadcast = {
    type: "chat",
    daemon_id: "d1",
    session_id: "s1",
    message_id: "01HXZ",
    from: "pwa",
    user: "alice@example.com",
    content: "hi",
    reply_to: null,
    ts: 1716000000,
  };
  const parsed = JSON.parse(JSON.stringify(f)) as HubToPwa;
  expect(parsed.type).toBe("chat");
  if (parsed.type === "chat") {
    expect(parsed.from).toBe("pwa");
    expect(parsed.user).toBe("alice@example.com");
  }
});

test("PwaChatBroadcast: from=claude has null user", () => {
  const f: PwaChatBroadcast = {
    type: "chat",
    daemon_id: "d1",
    session_id: "s1",
    message_id: "01HY1",
    from: "claude",
    user: null,
    content: "ack",
    reply_to: null,
    ts: 1716000001,
  };
  const parsed = JSON.parse(JSON.stringify(f)) as HubToPwa;
  if (parsed.type === "chat") {
    expect(parsed.from).toBe("claude");
    expect(parsed.user).toBeNull();
  }
});

// ─── HubChatErrorBroadcast ────────────────────────────────────────────
test("HubChatErrorBroadcast: round-trip narrows in HubToPwa", () => {
  const f: HubChatErrorBroadcast = {
    type: "chat_error",
    daemon_id: "d1",
    session_id: "s1",
    reason: "daemon_offline",
  };
  const parsed = JSON.parse(JSON.stringify(f)) as HubToPwa;
  expect(parsed.type).toBe("chat_error");
  if (parsed.type === "chat_error") {
    expect(parsed.reason).toBe("daemon_offline");
  }
});

// ─── PluginChatOut as DaemonToHub ─────────────────────────────────────
test("PluginChatOut narrows in DaemonToHub union", () => {
  const f: PluginChatOut = {
    type: "chat_out",
    session_id: "s1",
    content: "from claude",
    ts: 1716000002,
    reply_to: null,
  };
  const parsed = JSON.parse(JSON.stringify(f)) as DaemonToHub;
  expect(parsed.type).toBe("chat_out");
  if (parsed.type === "chat_out") {
    expect(parsed.content).toBe("from claude");
  }
});
