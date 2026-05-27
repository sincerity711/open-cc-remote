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
  DaemonStartSessionRejected,
  PwaStartSessionRejected,
  HubToDaemonStartSession,
  PwaToHubStartSession,
  SessionSnapshot,
  DaemonSessionOpenFrame,
  PwaSessionOpenFrame,
  DaemonSlashInventory,
  PwaSlashInventory,
  PwaToHubCliCommand,
  HubToDaemonCliCommand,
  SlashEntry,
  HookAskUserQuestionRequest,
  HookAskUserQuestionAnswer,
  DaemonAskUserQuestionRequest,
  PwaAskUserQuestionRequest,
  PwaToHubAskUserQuestionAnswer,
  HubAskUserQuestionAnswer,
  PluginToDaemon,
  DaemonToPlugin,
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

test("PwaToHubChatSend: trace ctx round-trips through JSON", () => {
  const f: PwaToHubChatSend = {
    type: "chat_send",
    daemon_id: "d1",
    session_id: "s1",
    content: "hi",
    trace: { traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" },
  };
  const parsed = JSON.parse(JSON.stringify(f)) as PwaToHub;
  expect(parsed.type).toBe("chat_send");
  if (parsed.type === "chat_send") {
    expect(parsed.trace?.traceparent).toBe("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01");
  }
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

// ─── start_session_rejected ───────────────────────────────────────────
test("DaemonStartSessionRejected narrows in DaemonToHub", () => {
  const f: DaemonStartSessionRejected = {
    type: "start_session_rejected",
    request_id: "rs-1",
    cwd: "/missing",
    reason: "cwd_not_allowed",
    message: "cwd /missing not in allowed_cwd_prefix",
  };
  const parsed = JSON.parse(JSON.stringify(f)) as DaemonToHub;
  expect(parsed.type).toBe("start_session_rejected");
  if (parsed.type === "start_session_rejected") {
    expect(parsed.reason).toBe("cwd_not_allowed");
    expect(parsed.request_id).toBe("rs-1");
  }
});

test("PwaStartSessionRejected narrows in HubToPwa", () => {
  const f: PwaStartSessionRejected = {
    type: "start_session_rejected",
    daemon_id: "d1",
    request_id: null,
    cwd: "/x",
    reason: "spawn_command_unset",
    message: "spawn_command not configured",
  };
  const parsed = JSON.parse(JSON.stringify(f)) as HubToPwa;
  expect(parsed.type).toBe("start_session_rejected");
  if (parsed.type === "start_session_rejected") {
    expect(parsed.daemon_id).toBe("d1");
    expect(parsed.reason).toBe("spawn_command_unset");
  }
});

test("PwaToHubStartSession allows optional request_id; HubToDaemonStartSession echoes", () => {
  const a: PwaToHubStartSession = {
    type: "start_session",
    daemon_id: "d1",
    cwd: "/work",
    request_id: "abc",
  };
  expect(a.request_id).toBe("abc");
  const b: HubToDaemonStartSession = {
    type: "start_session",
    cwd: "/work",
    request_id: "abc",
  };
  const parsed = JSON.parse(JSON.stringify(b)) as HubToDaemon;
  if (parsed.type === "start_session") {
    expect(parsed.request_id).toBe("abc");
  }
});

// ─── SessionSnapshot.claude_session_id (item #7) ──────────────────────
test("SessionSnapshot accepts claude_session_id as string OR null", () => {
  const fresh: SessionSnapshot = {
    session_id: "s1", claude_session_id: null, tmux_session: null, tmux_pane: null,
    cwd: "/x", model: null, pid: 1, started_at: 1, claude_client_version: "v",
    plugin_version: "v", state: "idle",
  };
  const bound: SessionSnapshot = { ...fresh, claude_session_id: "uuid-claude" };
  expect(fresh.claude_session_id).toBeNull();
  expect(bound.claude_session_id).toBe("uuid-claude");
});

// ─── client_message_id correlation (Task 1) ───────────────────────────
test("PwaToHubChatSend carries optional client_message_id", () => {
  const f: PwaToHubChatSend = {
    type: "chat_send",
    daemon_id: "d", session_id: "s",
    content: "hi",
    client_message_id: "cm-1",
  };
  expect(f.client_message_id).toBe("cm-1");
});

test("PwaChatBroadcast preserves client_message_id round-trip", () => {
  const f: PwaChatBroadcast = {
    type: "chat",
    daemon_id: "d", session_id: "s",
    message_id: "m-1",
    from: "pwa",
    user: "alice",
    content: "hi",
    reply_to: null,
    ts: 0,
    client_message_id: "cm-1",
  };
  expect(f.client_message_id).toBe("cm-1");
});

test("HubChatErrorBroadcast preserves client_message_id round-trip", () => {
  const f: HubChatErrorBroadcast = {
    type: "chat_error",
    daemon_id: "d", session_id: "s",
    reason: "daemon_offline",
    client_message_id: "cm-1",
  };
  expect(f.client_message_id).toBe("cm-1");
});

// ─── request_id on session_open (Task 2) ──────────────────────────────

test("DaemonSessionOpenFrame carries optional request_id", () => {
  const f: DaemonSessionOpenFrame = {
    type: "session_open",
    session: {
      session_id: "s", claude_session_id: null,
      tmux_session: null, tmux_pane: null,
      cwd: "/x", model: null, pid: 1,
      started_at: 0, claude_client_version: "v",
      plugin_version: "v", state: "idle",
    },
    request_id: "req-1",
  };
  expect(f.request_id).toBe("req-1");
});

test("PwaSessionOpenFrame carries optional request_id", () => {
  const f: PwaSessionOpenFrame = {
    type: "session_open",
    daemon_id: "d",
    session: {
      session_id: "s", claude_session_id: null,
      tmux_session: null, tmux_pane: null,
      cwd: "/x", model: null, pid: 1,
      started_at: 0, claude_client_version: "v",
      plugin_version: "v", state: "idle",
    },
    request_id: "req-1",
  };
  expect(f.request_id).toBe("req-1");
});

// ─── slash_inventory + cli_command (Task 1 of slash-input-helper) ─────

test("DaemonSlashInventory round-trips through JSON", () => {
  const entry: SlashEntry = {
    id: "skill:brainstorming",
    name: "/brainstorming",
    description: "Turn an idea into a design",
    source: "skill",
  };
  const f: DaemonSlashInventory = {
    type: "slash_inventory",
    session_id: "s1",
    entries: [entry],
  };
  const parsed = JSON.parse(JSON.stringify(f)) as DaemonToHub;
  expect(parsed.type).toBe("slash_inventory");
  if (parsed.type === "slash_inventory") {
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]!.source).toBe("skill");
    expect(parsed.entries[0]!.id).toBe("skill:brainstorming");
  }
});

test("PwaSlashInventory carries daemon_id", () => {
  const f: PwaSlashInventory = {
    type: "slash_inventory",
    daemon_id: "d-1",
    session_id: "s1",
    entries: [],
  };
  const parsed = JSON.parse(JSON.stringify(f)) as HubToPwa;
  expect(parsed.type).toBe("slash_inventory");
  if (parsed.type === "slash_inventory") {
    expect(parsed.daemon_id).toBe("d-1");
  }
});

test("PwaToHubCliCommand round-trips with verbatim text", () => {
  const f: PwaToHubCliCommand = {
    type: "cli_command",
    daemon_id: "d-1",
    session_id: "s1",
    text: "/brainstorming todo app",
  };
  const parsed = JSON.parse(JSON.stringify(f)) as PwaToHub;
  expect(parsed.type).toBe("cli_command");
  if (parsed.type === "cli_command") {
    expect(parsed.text).toBe("/brainstorming todo app");
  }
});

test("HubToDaemonCliCommand includes user for audit", () => {
  const f: HubToDaemonCliCommand = {
    type: "cli_command",
    session_id: "s1",
    text: "/clear",
    user: "alice@example.com",
  };
  const parsed = JSON.parse(JSON.stringify(f)) as HubToDaemon;
  expect(parsed.type).toBe("cli_command");
  if (parsed.type === "cli_command") {
    expect(parsed.user).toBe("alice@example.com");
  }
});

// ─── ask_user_question relay ──────────────────────────────────────────

test("HookAskUserQuestionRequest: shape narrows on type", () => {
  const f: HookAskUserQuestionRequest = {
    type: "ask_user_question_request",
    claude_session_id: "cs1",
    request_id: "rq1",
    questions: [
      {
        question: "Where to put the file?",
        header: "Location",
        multiSelect: false,
        options: [
          { label: "docs/", description: "alongside other docs" },
          { label: "src/", description: "next to code" },
        ],
      },
    ],
    expires_at: 123,
  };
  const parsed = JSON.parse(JSON.stringify(f)) as PluginToDaemon;
  expect(parsed.type).toBe("ask_user_question_request");
  if (parsed.type === "ask_user_question_request") {
    expect(parsed.claude_session_id).toBe("cs1");
    expect(parsed.questions[0]?.options[0]?.label).toBe("docs/");
  }
});

test("HookAskUserQuestionAnswer: resolution variants", () => {
  const variants: HookAskUserQuestionAnswer["resolution"][] = [
    "answered", "expired", "session_unknown", "no_pwa",
  ];
  for (const r of variants) {
    const f: HookAskUserQuestionAnswer = {
      type: "ask_user_question_answer",
      request_id: "rq1",
      answers: ["docs/"],
      resolution: r,
    };
    const parsed = JSON.parse(JSON.stringify(f)) as DaemonToPlugin;
    expect(parsed.type).toBe("ask_user_question_answer");
    if (parsed.type === "ask_user_question_answer") {
      expect(parsed.resolution).toBe(r);
    }
  }
});

test("DaemonAskUserQuestionRequest narrows in DaemonToHub", () => {
  const f: DaemonAskUserQuestionRequest = {
    type: "ask_user_question_request",
    session_id: "s1",
    request_id: "rq1",
    questions: [{ question: "?", header: "H", multiSelect: false, options: [{ label: "a" }] }],
    expires_at: 0,
  };
  const parsed = JSON.parse(JSON.stringify(f)) as DaemonToHub;
  expect(parsed.type).toBe("ask_user_question_request");
});

test("PwaAskUserQuestionRequest narrows in HubToPwa with daemon_id", () => {
  const f: PwaAskUserQuestionRequest = {
    type: "ask_user_question_request",
    daemon_id: "d1",
    session_id: "s1",
    request_id: "rq1",
    questions: [{ question: "?", header: "H", multiSelect: true, options: [{ label: "x" }, { label: "y" }] }],
    expires_at: 0,
  };
  const parsed = JSON.parse(JSON.stringify(f)) as HubToPwa;
  expect(parsed.type).toBe("ask_user_question_request");
  if (parsed.type === "ask_user_question_request") {
    expect(parsed.daemon_id).toBe("d1");
    expect(parsed.questions[0]?.multiSelect).toBe(true);
  }
});

test("PwaToHubAskUserQuestionAnswer + HubAskUserQuestionAnswer round-trip", () => {
  const a: PwaToHubAskUserQuestionAnswer = {
    type: "ask_user_question_answer",
    daemon_id: "d1",
    session_id: "s1",
    request_id: "rq1",
    answers: ["docs/", null],
  };
  const ap = JSON.parse(JSON.stringify(a)) as PwaToHub;
  expect(ap.type).toBe("ask_user_question_answer");

  const b: HubAskUserQuestionAnswer = {
    type: "ask_user_question_answer",
    session_id: "s1",
    request_id: "rq1",
    answers: ["docs/", null],
  };
  const bp = JSON.parse(JSON.stringify(b)) as HubToDaemon;
  expect(bp.type).toBe("ask_user_question_answer");
  if (bp.type === "ask_user_question_answer") {
    expect(bp.answers).toEqual(["docs/", null]);
  }
});
