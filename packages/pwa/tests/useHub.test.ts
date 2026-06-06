import { expect, test } from "bun:test";
import type { EventFrameForPwa } from "@cc-remote/proto";
import { appendEventToBuffer, reducer, initialHubState, type BufferedEvent } from "../src/hooks/useHub";

function ev(jsonl_offset: number, payload: EventFrameForPwa["payload"] = []): EventFrameForPwa {
  return {
    type: "event",
    daemon_id: "d",
    session_id: "s",
    jsonl_offset,
    payload,
  };
}

// Helper: build a BufferedEvent[] from an existing buffer for easier assertions.
function offsets(buf: BufferedEvent[]): number[] {
  // Return unique jsonl_offsets in order (each row may produce multiple entries).
  const seen = new Set<number>();
  const result: number[] = [];
  for (const e of buf) {
    if (!seen.has(e.jsonl_offset)) { seen.add(e.jsonl_offset); result.push(e.jsonl_offset); }
  }
  return result;
}

test("appendEventToBuffer adds a new frame (empty payload → 0 BufferedEvents, no offset)", () => {
  // An empty-payload frame still deduplicates but produces 0 BufferedEvents.
  const out = appendEventToBuffer([], ev(10, []));
  expect(out).toHaveLength(0);
});

test("appendEventToBuffer flattens payload[] into individual BufferedEvent records", () => {
  const agEvent = { type: "TEXT_MESSAGE_CHUNK" } as EventFrameForPwa["payload"][number];
  const frame = ev(10, [agEvent, agEvent]);
  const out = appendEventToBuffer([], frame);
  expect(out).toHaveLength(2);
  expect(out[0].jsonl_offset).toBe(10);
  expect(out[0].event_index).toBe(0);
  expect(out[1].event_index).toBe(1);
  expect(out[0].daemon_id).toBe("d");
  expect(out[0].session_id).toBe("s");
  // No `timestamp` on the AG-UI event → ts falls back to 0 (per BufferedEvent contract).
  expect(out[0].ts).toBe(0);
});

test("appendEventToBuffer derives ts from each AG-UI event's `timestamp` field", () => {
  // Event-time provenance: claude-code's JSONL row carries `timestamp`,
  // the adapter (parseTimestampMs) hangs it on each AGUIEvent, and the
  // PWA's BufferedEvent.ts is sourced from there — NOT from the frame
  // envelope (which is now ts-less; cf. proto/frames.ts EventFrame).
  const a = { type: "TEXT_MESSAGE_CHUNK", timestamp: 1_700_000_000_010 } as unknown as EventFrameForPwa["payload"][number];
  const b = { type: "TEXT_MESSAGE_CHUNK", timestamp: 1_700_000_000_020 } as unknown as EventFrameForPwa["payload"][number];
  const frame = ev(10, [a, b]);
  const out = appendEventToBuffer([], frame);
  expect(out[0].ts).toBe(1_700_000_000_010);
  expect(out[1].ts).toBe(1_700_000_000_020);
});

test("appendEventToBuffer dedupes by jsonl_offset and returns the same array reference", () => {
  // Why same reference: useHub's reducer uses identity equality to skip the
  // React rerender on dedup hits. If this changes, downstream rerender
  // behavior breaks.
  const agEvent = { type: "TEXT_MESSAGE_CHUNK" } as EventFrameForPwa["payload"][number];
  const start = appendEventToBuffer([], ev(10, [agEvent]));
  const start2 = appendEventToBuffer(start, ev(20, [agEvent]));
  // Dedup: frame with offset 10 already present — must return same reference.
  const out = appendEventToBuffer(start2, ev(10, [agEvent]));
  expect(out).toBe(start2);
  expect(offsets(out)).toEqual([10, 20]);
});

test("appendEventToBuffer dedupes the late-arriving event from the daemon's bind drain", () => {
  // The race the daemon fix addresses: a user-injected line arrives via the
  // initial drain (offset 100) AND, on reconnect, also via the live tail.
  // PWA must not show two user bubbles for the same JSONL line.
  const agEvent = { type: "TEXT_MESSAGE_CHUNK" } as EventFrameForPwa["payload"][number];
  const initial: BufferedEvent[] = [];
  const afterDrain = appendEventToBuffer(initial, ev(100, [agEvent]));
  const afterLive = appendEventToBuffer(afterDrain, ev(100, [agEvent]));
  expect(offsets(afterLive)).toEqual([100]);
});

test("appendEventToBuffer trims to max length, keeping the newest frames", () => {
  const agEvent = { type: "TEXT_MESSAGE_CHUNK" } as EventFrameForPwa["payload"][number];
  // Each frame has 1 event → 1 BufferedEvent per offset.
  let buf: BufferedEvent[] = [];
  buf = appendEventToBuffer(buf, ev(1, [agEvent]));
  buf = appendEventToBuffer(buf, ev(2, [agEvent]));
  buf = appendEventToBuffer(buf, ev(3, [agEvent]));
  // max=3 means after adding offset 4 the oldest (offset 1) is dropped.
  const out = appendEventToBuffer(buf, ev(4, [agEvent]), 3);
  expect(offsets(out)).toEqual([2, 3, 4]);
});

test("appendEventToBuffer doesn't trim when under max", () => {
  const agEvent = { type: "TEXT_MESSAGE_CHUNK" } as EventFrameForPwa["payload"][number];
  let buf: BufferedEvent[] = [];
  buf = appendEventToBuffer(buf, ev(1, [agEvent]));
  const out = appendEventToBuffer(buf, ev(2, [agEvent]), 5);
  expect(offsets(out)).toEqual([1, 2]);
});

// ─── reducer tests ────────────────────────────────────────────────────────────

test("chat_send creates a pending entry keyed by client_message_id", () => {
  const after = reducer(initialHubState(), {
    type: "outbound_chat_send",
    daemon_id: "d", session_id: "s",
    client_message_id: "cm-1",
    started_at: 1,
  });
  const cmd = after.pendingCommands["cm-1"];
  expect(cmd?.kind).toBe("chat_send");
  expect(cmd?.daemon_id).toBe("d");
  expect(cmd?.session_id).toBe("s");
  expect(cmd?.status).toBe("pending");
});

test("chat broadcast with matching client_message_id clears pending", () => {
  let s = reducer(initialHubState(), {
    type: "outbound_chat_send",
    daemon_id: "d", session_id: "s",
    client_message_id: "cm-1",
    started_at: 1,
  });
  s = reducer(s, {
    type: "frame",
    frame: {
      type: "chat",
      daemon_id: "d", session_id: "s",
      message_id: "m-1", from: "pwa", user: "alice",
      content: "hi", reply_to: null, ts: 0,
      client_message_id: "cm-1",
    },
  });
  expect(s.pendingCommands["cm-1"]).toBeUndefined();
});

test("chat_error with matching client_message_id marks pending failed", () => {
  let s = reducer(initialHubState(), {
    type: "outbound_chat_send",
    daemon_id: "d", session_id: "s",
    client_message_id: "cm-1",
    started_at: 1,
  });
  s = reducer(s, {
    type: "frame",
    frame: {
      type: "chat_error",
      daemon_id: "d", session_id: "s",
      reason: "daemon_offline",
      client_message_id: "cm-1",
    },
  });
  expect(s.pendingCommands["cm-1"]?.status).toBe("failed");
  expect(s.pendingCommands["cm-1"]?.error).toBe("daemon_offline");
});

test("command_timeout marks pending as timed_out", () => {
  let s = reducer(initialHubState(), {
    type: "outbound_chat_send",
    daemon_id: "d", session_id: "s",
    client_message_id: "cm-1",
    started_at: 1,
  });
  s = reducer(s, { type: "command_timeout", id: "cm-1" });
  expect(s.pendingCommands["cm-1"]?.status).toBe("timed_out");
});

test("reducer command_dismiss returns same reference on missing id", () => {
  const start = initialHubState();
  const out = reducer(start, { type: "command_dismiss", id: "nope" });
  expect(out).toBe(start);
});

test("reducer command_timeout returns same reference on missing id", () => {
  const start = initialHubState();
  const out = reducer(start, { type: "command_timeout", id: "nope" });
  expect(out).toBe(start);
});

test("reducer chat with no client_message_id leaves pendingCommands unchanged", () => {
  let s = reducer(initialHubState(), {
    type: "outbound_chat_send",
    daemon_id: "d", session_id: "s",
    client_message_id: "cm-1",
    started_at: 1,
  });
  const before = s.pendingCommands;
  s = reducer(s, {
    type: "frame",
    frame: {
      type: "chat",
      daemon_id: "d", session_id: "s",
      message_id: "m-1", from: "claude", user: null,
      content: "hi", reply_to: null, ts: 0,
      // no client_message_id
    },
  });
  expect(s.pendingCommands).toBe(before);
});

test("reducer chat_error with no client_message_id leaves pendingCommands unchanged", () => {
  let s = reducer(initialHubState(), {
    type: "outbound_chat_send",
    daemon_id: "d", session_id: "s",
    client_message_id: "cm-1",
    started_at: 1,
  });
  const before = s.pendingCommands;
  s = reducer(s, {
    type: "frame",
    frame: {
      type: "chat_error",
      daemon_id: "d", session_id: "s",
      reason: "daemon_offline",
      // no client_message_id
    },
  });
  expect(s.pendingCommands).toBe(before);
});

test("reducer clear_start_session_error returns same reference when no error present", () => {
  const start = initialHubState();
  const out = reducer(start, { type: "clear_start_session_error", daemon_id: "d" });
  expect(out).toBe(start);
});

test("start_session pending cleared by matching session_open", () => {
  let s = reducer(initialHubState(), {
    type: "outbound_start_session",
    daemon_id: "d", request_id: "rs-1", started_at: 1,
  });
  expect(s.pendingCommands["rs-1"]?.kind).toBe("start_session");
  s = reducer(s, {
    type: "frame",
    frame: {
      type: "session_open",
      daemon_id: "d",
      session: {
        session_id: "s", claude_session_id: null,
        tmux_session: null, tmux_pane: null,
        cwd: "/x", model: null, pid: 1, started_at: 0,
        claude_client_version: "v", plugin_version: "v",
        state: "idle",
      },
      request_id: "rs-1",
    },
  });
  expect(s.pendingCommands["rs-1"]).toBeUndefined();
});

test("start_session_rejected with matching request_id marks failed", () => {
  let s = reducer(initialHubState(), {
    type: "outbound_start_session",
    daemon_id: "d", request_id: "rs-1", started_at: 1,
  });
  s = reducer(s, {
    type: "frame",
    frame: {
      type: "start_session_rejected",
      daemon_id: "d", request_id: "rs-1",
      cwd: "/x", reason: "not_allowed", message: "nope",
    },
  });
  expect(s.pendingCommands["rs-1"]?.status).toBe("failed");
  expect(s.pendingCommands["rs-1"]?.error).toBe("nope");
});

test("session_open without request_id does not affect pendingCommands identity", () => {
  let s = reducer(initialHubState(), {
    type: "outbound_start_session",
    daemon_id: "d", request_id: "rs-1", started_at: 1,
  });
  const before = s.pendingCommands;
  s = reducer(s, {
    type: "frame",
    frame: {
      type: "session_open",
      daemon_id: "d",
      session: {
        session_id: "s2", claude_session_id: null,
        tmux_session: null, tmux_pane: null,
        cwd: "/x", model: null, pid: 1, started_at: 0,
        claude_client_version: "v", plugin_version: "v",
        state: "idle",
      },
      // no request_id
    },
  });
  expect(s.pendingCommands).toBe(before);
});

test("request_history coalesces while pending for same session", () => {
  let s = reducer(initialHubState(), {
    type: "outbound_request_history",
    daemon_id: "d", session_id: "s", request_id: "rh-1", started_at: 1,
  });
  s = reducer(s, {
    type: "outbound_request_history",
    daemon_id: "d", session_id: "s", request_id: "rh-2", started_at: 2,
  });
  expect(s.pendingCommands["rh-1"]).toBeDefined();
  expect(s.pendingCommands["rh-2"]).toBeUndefined();
});

test("request_history allows distinct sessions to be pending concurrently", () => {
  let s = reducer(initialHubState(), {
    type: "outbound_request_history",
    daemon_id: "d", session_id: "s1", request_id: "rh-1", started_at: 1,
  });
  s = reducer(s, {
    type: "outbound_request_history",
    daemon_id: "d", session_id: "s2", request_id: "rh-2", started_at: 2,
  });
  expect(s.pendingCommands["rh-1"]).toBeDefined();
  expect(s.pendingCommands["rh-2"]).toBeDefined();
});

test("history_chunk clears pending request_history (non-empty)", () => {
  let s = reducer(initialHubState(), {
    type: "outbound_request_history",
    daemon_id: "d", session_id: "s", request_id: "rh-1", started_at: 1,
  });
  s = reducer(s, {
    type: "frame",
    frame: {
      type: "history_chunk",
      daemon_id: "d", session_id: "s",
      request_id: "rh-1",
      events: [{
        jsonl_offset: 5,
        payload: [{ type: "RAW", event: { type: "session_start" } } as any],
      }],
    },
  });
  expect(s.pendingCommands["rh-1"]).toBeUndefined();
});

test("history_chunk clears pending request_history (empty)", () => {
  let s = reducer(initialHubState(), {
    type: "outbound_request_history",
    daemon_id: "d", session_id: "s", request_id: "rh-1", started_at: 1,
  });
  s = reducer(s, {
    type: "frame",
    frame: {
      type: "history_chunk",
      daemon_id: "d", session_id: "s",
      request_id: "rh-1",
      events: [],
    },
  });
  expect(s.pendingCommands["rh-1"]).toBeUndefined();
});

test("outbound_chat_send drops stale failed entry for same session", () => {
  let s = reducer(initialHubState(), {
    type: "outbound_chat_send",
    daemon_id: "d", session_id: "s",
    client_message_id: "cm-old",
    started_at: 1,
  });
  s = reducer(s, { type: "command_timeout", id: "cm-old" });
  expect(s.pendingCommands["cm-old"]?.status).toBe("timed_out");
  s = reducer(s, {
    type: "outbound_chat_send",
    daemon_id: "d", session_id: "s",
    client_message_id: "cm-new",
    started_at: 2,
  });
  expect(s.pendingCommands["cm-old"]).toBeUndefined();
  expect(s.pendingCommands["cm-new"]?.status).toBe("pending");
});

test("outbound_start_session drops stale failed entry for same daemon", () => {
  let s = reducer(initialHubState(), {
    type: "outbound_start_session",
    daemon_id: "d", request_id: "rs-old", started_at: 1,
  });
  s = reducer(s, { type: "command_timeout", id: "rs-old" });
  s = reducer(s, {
    type: "outbound_start_session",
    daemon_id: "d", request_id: "rs-new", started_at: 2,
  });
  expect(s.pendingCommands["rs-old"]).toBeUndefined();
  expect(s.pendingCommands["rs-new"]?.status).toBe("pending");
});

test("outbound_request_history drops stale timed_out entry for same session", () => {
  let s = reducer(initialHubState(), {
    type: "outbound_request_history",
    daemon_id: "d", session_id: "s", request_id: "rh-old", started_at: 1,
  });
  s = reducer(s, { type: "command_timeout", id: "rh-old" });
  s = reducer(s, {
    type: "outbound_request_history",
    daemon_id: "d", session_id: "s", request_id: "rh-new", started_at: 2,
  });
  expect(s.pendingCommands["rh-old"]).toBeUndefined();
  expect(s.pendingCommands["rh-new"]?.status).toBe("pending");
});

test("permission_reply is NOT optimistically removed", () => {
  let s = reducer(initialHubState(), {
    type: "frame",
    frame: {
      type: "permission_request",
      daemon_id: "d", session_id: "s",
      request_id: "p-1",
      tool: "Bash", args_summary: "ls",
      expires_at: 1_700_000_000,
    },
  });
  s = reducer(s, {
    type: "outbound_permission_reply",
    daemon_id: "d", session_id: "s", request_id: "p-1",
    decision: "allow", started_at: 1,
  });
  expect(s.pendingPermissions["p-1"]).toBeDefined();
  expect(s.pendingCommands["p-1"]?.kind).toBe("permission_reply");
  expect(s.pendingCommands["p-1"]?.label).toBe("allow");
});

test("permission_resolved clears pending entry and pending command", () => {
  let s = reducer(initialHubState(), {
    type: "frame",
    frame: {
      type: "permission_request",
      daemon_id: "d", session_id: "s",
      request_id: "p-1",
      tool: "Bash", args_summary: "ls",
      expires_at: 1_700_000_000,
    },
  });
  s = reducer(s, {
    type: "outbound_permission_reply",
    daemon_id: "d", session_id: "s", request_id: "p-1",
    decision: "allow", started_at: 1,
  });
  s = reducer(s, {
    type: "frame",
    frame: {
      type: "permission_resolved",
      daemon_id: "d", session_id: "s",
      request_id: "p-1",
      decision: "allow", decided_via: "pwa",
    },
  });
  expect(s.pendingPermissions["p-1"]).toBeUndefined();
  expect(s.pendingCommands["p-1"]).toBeUndefined();
});

test("kill_session creates pending and is cleared by session_close", () => {
  let s = reducer(initialHubState(), {
    type: "outbound_kill_session",
    daemon_id: "d", session_id: "s", started_at: 1,
  });
  expect(s.pendingCommands["kill-d-s"]?.kind).toBe("kill_session");
  s = reducer(s, {
    type: "frame",
    frame: { type: "session_close", daemon_id: "d", session_id: "s", reason: "killed" },
  });
  expect(s.pendingCommands["kill-d-s"]).toBeUndefined();
});

test("kill_session is coalesced for the same session", () => {
  let s = reducer(initialHubState(), {
    type: "outbound_kill_session",
    daemon_id: "d", session_id: "s", started_at: 1,
  });
  const before = s.pendingCommands["kill-d-s"];
  s = reducer(s, {
    type: "outbound_kill_session",
    daemon_id: "d", session_id: "s", started_at: 2,
  });
  expect(s.pendingCommands["kill-d-s"]).toBe(before);
});

test("kill_session in distinct sessions are independent", () => {
  let s = reducer(initialHubState(), {
    type: "outbound_kill_session",
    daemon_id: "d", session_id: "s1", started_at: 1,
  });
  s = reducer(s, {
    type: "outbound_kill_session",
    daemon_id: "d", session_id: "s2", started_at: 2,
  });
  expect(s.pendingCommands["kill-d-s1"]?.kind).toBe("kill_session");
  expect(s.pendingCommands["kill-d-s2"]?.kind).toBe("kill_session");
});

test("permission_resolved clears pending command even if pendingPermissions is missing the entry", () => {
  let s = reducer(initialHubState(), {
    type: "outbound_permission_reply",
    daemon_id: "d", session_id: "s", request_id: "p-1",
    decision: "allow", started_at: 1,
  });
  // Note: NO permission_request was inserted; pendingPermissions is empty.
  s = reducer(s, {
    type: "frame",
    frame: {
      type: "permission_resolved",
      daemon_id: "d", session_id: "s",
      request_id: "p-1",
      decision: "allow", decided_via: "pwa",
    },
  });
  expect(s.pendingCommands["p-1"]).toBeUndefined();
});

test("ask_user_question_request adds to pendingQuestions; resolved clears it", () => {
  const askFrame = {
    type: "ask_user_question_request" as const,
    daemon_id: "d", session_id: "s",
    request_id: "ask-1",
    questions: [{
      question: "Where to put it?",
      header: "Location",
      multiSelect: false,
      options: [{ label: "docs/" }, { label: "src/" }],
    }],
    expires_at: 9999,
  };
  let s = reducer(initialHubState(), { type: "frame", frame: askFrame });
  expect(s.pendingQuestions["ask-1"]).toBeDefined();
  expect(s.pendingQuestions["ask-1"]?.questions[0]?.options[0]?.label).toBe("docs/");

  s = reducer(s, {
    type: "outbound_ask_answer",
    daemon_id: "d", session_id: "s", request_id: "ask-1", started_at: 1,
    answers: ["docs/"],
  });
  expect(s.pendingQuestions["ask-1"]).toBeDefined();
  expect(s.pendingCommands["ask-1"]?.kind).toBe("ask_answer");
  expect(s.pendingCommands["ask-1"]?.status).toBe("pending");

  s = reducer(s, {
    type: "frame",
    frame: {
      type: "ask_user_question_resolved",
      daemon_id: "d", session_id: "s", request_id: "ask-1",
      resolution: "answered",
    },
  });
  expect(s.pendingQuestions["ask-1"]).toBeUndefined();
  expect(s.pendingCommands["ask-1"]).toBeUndefined();
});

test("ask_user_question_resolved with no local pendingQuestions still clears pendingCommand", () => {
  let s = reducer(initialHubState(), {
    type: "outbound_ask_answer",
    daemon_id: "d", session_id: "s", request_id: "ask-2", started_at: 1,
    answers: ["yes"],
  });
  expect(s.pendingCommands["ask-2"]?.kind).toBe("ask_answer");
  s = reducer(s, {
    type: "frame",
    frame: {
      type: "ask_user_question_resolved",
      daemon_id: "d", session_id: "s", request_id: "ask-2",
      resolution: "answered",
    },
  });
  expect(s.pendingCommands["ask-2"]).toBeUndefined();
});

// ─── Sticky history caches for ResolvedPermissionCard / ResolvedAskQuestionCard

test("permission_request populates permissionRequestHistory (sticky cache)", () => {
  const s = reducer(initialHubState(), {
    type: "frame",
    frame: {
      type: "permission_request",
      daemon_id: "d", session_id: "s",
      request_id: "p-h1",
      tool: "Bash", args_summary: "rm -rf /tmp",
      expires_at: 1_700_000_000,
    },
  });
  expect(s.pendingPermissions["p-h1"]).toBeDefined();
  expect(s.permissionRequestHistory["p-h1"]).toBeDefined();
  expect(s.permissionRequestHistory["p-h1"]?.args_summary).toBe("rm -rf /tmp");
});

test("permission_resolved leaves permissionRequestHistory intact (sticky)", () => {
  let s = reducer(initialHubState(), {
    type: "frame",
    frame: {
      type: "permission_request",
      daemon_id: "d", session_id: "s",
      request_id: "p-h2",
      tool: "Bash", args_summary: "ls",
      expires_at: 1_700_000_000,
    },
  });
  s = reducer(s, {
    type: "frame",
    frame: {
      type: "permission_resolved",
      daemon_id: "d", session_id: "s",
      request_id: "p-h2",
      decision: "allow", decided_via: "pwa",
    },
  });
  expect(s.pendingPermissions["p-h2"]).toBeUndefined();
  // History MUST survive resolve so the resolved card can still look up the
  // original tool/args_summary.
  expect(s.permissionRequestHistory["p-h2"]?.args_summary).toBe("ls");
});

test("permission_resolved appends to permissionResolutions (per-session buffer)", () => {
  let s = reducer(initialHubState(), {
    type: "frame",
    frame: {
      type: "permission_resolved",
      daemon_id: "d", session_id: "s",
      request_id: "p-r1",
      decision: "deny", decided_via: "pwa",
    },
  });
  expect(s.permissionResolutions["d::s"]).toBeDefined();
  expect(s.permissionResolutions["d::s"]?.length).toBe(1);
  expect(s.permissionResolutions["d::s"]?.[0]?.request_id).toBe("p-r1");
});

test("ask_user_question_request populates askQuestionRequestHistory", () => {
  const s = reducer(initialHubState(), {
    type: "frame",
    frame: {
      type: "ask_user_question_request",
      daemon_id: "d", session_id: "s",
      request_id: "ask-h1",
      questions: [{ question: "Q?", header: "", multiSelect: false, options: [{ label: "yes" }] }],
      expires_at: 9999,
    },
  });
  expect(s.askQuestionRequestHistory["ask-h1"]?.questions[0]?.question).toBe("Q?");
});

test("outbound_ask_answer populates askQuestionAnswerHistory", () => {
  const s = reducer(initialHubState(), {
    type: "outbound_ask_answer",
    daemon_id: "d", session_id: "s", request_id: "ask-h2",
    started_at: 1,
    answers: ["docs/", null],
  });
  expect(s.askQuestionAnswerHistory["ask-h2"]).toEqual(["docs/", null]);
});

test("ask_user_question_resolved appends to askQuestionResolutions buffer", () => {
  const s = reducer(initialHubState(), {
    type: "frame",
    frame: {
      type: "ask_user_question_resolved",
      daemon_id: "d", session_id: "s", request_id: "ask-r1",
      resolution: "answered",
    },
  });
  expect(s.askQuestionResolutions["d::s"]?.length).toBe(1);
  expect(s.askQuestionResolutions["d::s"]?.[0]?.resolution).toBe("answered");
});

test("permissionRequestHistory evicts oldest at LRU bound (64)", () => {
  let s = initialHubState();
  for (let i = 0; i < 65; i++) {
    s = reducer(s, {
      type: "frame",
      frame: {
        type: "permission_request",
        daemon_id: "d", session_id: "s",
        request_id: `p${i}`,
        tool: "Bash", args_summary: `cmd-${i}`,
        expires_at: 0,
      },
    });
  }
  expect(Object.keys(s.permissionRequestHistory)).toHaveLength(64);
  expect(s.permissionRequestHistory["p0"]).toBeUndefined();
  expect(s.permissionRequestHistory["p64"]).toBeDefined();
});
