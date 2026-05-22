import { expect, test } from "bun:test";
import type {
  EventFrameForPwa,
  PwaChatBroadcast,
  PwaPermissionRequest,
  PwaPermissionResolved,
} from "@cc-remote/proto";
import { mergeTimeline } from "../src/lib/timeline";

const D = "daemon-1";
const S = "session-1";

function chat(
  message_id: string,
  from: "pwa" | "claude",
  content: string,
  ts: number,
): PwaChatBroadcast {
  return {
    type: "chat",
    daemon_id: D,
    session_id: S,
    message_id,
    from,
    user: from === "pwa" ? "alice@example.com" : null,
    content,
    reply_to: null,
    ts,
  };
}

function event(
  jsonl_offset: number,
  ts: number,
  payload: unknown,
): EventFrameForPwa {
  return {
    type: "event",
    daemon_id: D,
    session_id: S,
    jsonl_offset,
    ts,
    payload,
  };
}

function pending(request_id: string, expires_at: number): PwaPermissionRequest {
  return {
    type: "permission_request",
    daemon_id: D,
    session_id: S,
    request_id,
    tool: "Bash",
    args_summary: "rm -rf /tmp/foo",
    expires_at,
  };
}

function resolved(
  request_id: string,
  decision: PwaPermissionResolved["decision"],
): PwaPermissionResolved {
  return {
    type: "permission_resolved",
    daemon_id: D,
    session_id: S,
    request_id,
    decision,
    decided_via: "pwa",
  };
}

test("empty inputs produce empty timeline", () => {
  expect(mergeTimeline({ events: [], chat: [], pending: [], resolved: [] })).toEqual([]);
});

test("chat broadcasts emit user and assistant items in order", () => {
  const items = mergeTimeline({
    events: [],
    chat: [
      chat("m1", "pwa", "hello", 1_700_000_000),
      chat("m2", "claude", "hi", 1_700_000_001),
    ],
    pending: [],
    resolved: [],
  });
  expect(items).toHaveLength(2);
  expect(items[0]).toMatchObject({ kind: "user", body: "hello" });
  expect(items[1]).toMatchObject({ kind: "assistant", body: "hi" });
});

test("each EventFrame falls through to raw with payload type as title", () => {
  const items = mergeTimeline({
    events: [
      event(10, 1_700_000_000_000, { type: "session_start", model: "sonnet" }),
      event(20, 1_700_000_001_000, { type: "tool_use", name: "Bash" }),
      event(30, 1_700_000_002_000, { whatever: true }),
    ],
    chat: [],
    pending: [],
    resolved: [],
  });
  expect(items).toHaveLength(3);
  expect(items[0]).toMatchObject({ kind: "raw", title: "session_start" });
  expect(items[1]).toMatchObject({ kind: "raw", title: "tool_use" });
  expect(items[2]).toMatchObject({ kind: "raw", title: "event" });
  // The json field round-trips via JSON.parse for safety.
  for (const item of items) {
    if (item.kind === "raw") {
      expect(() => JSON.parse(item.json)).not.toThrow();
    }
  }
});

test("user/assistant JSONL events are skipped (chat broadcasts cover them)", () => {
  const items = mergeTimeline({
    events: [
      event(10, 1_700_000_000_000, { type: "user", message: { content: "hi" } }),
      event(20, 1_700_000_001_000, { type: "assistant", message: { content: "hello" } }),
      event(30, 1_700_000_002_000, { type: "tool_use" }),
    ],
    chat: [],
    pending: [],
    resolved: [],
  });
  // Only the tool_use event survives; user/assistant are filtered.
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ kind: "raw", title: "tool_use" });
});

test("protocol-internal payload types are dropped from the timeline", () => {
  // Real Claude JSONL includes attachment, summary, queue-operation,
  // mcp_instructions_data, ai-title, file-history-snapshot, last-prompt,
  // permission-mode, pr-link, and system payloads. These are session-control
  // noise and must not surface as raw cards.
  const hidden = [
    "attachment",
    "summary",
    "queue-operation",
    "mcp_instructions_data",
    "ai-title",
    "system",
    "file-history-snapshot",
    "last-prompt",
    "permission-mode",
    "pr-link",
  ];
  for (const type of hidden) {
    const items = mergeTimeline({
      events: [event(10, 1_700_000_000_000, { type })],
      chat: [],
      pending: [],
      resolved: [],
    });
    expect(items, `payload type "${type}" must be filtered`).toHaveLength(0);
  }
});

test("pending permissions emit permission-inline items", () => {
  const items = mergeTimeline({
    events: [],
    chat: [],
    pending: [pending("req-1", 1_700_000_010)],
    resolved: [],
  });
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    kind: "permission-inline",
    tool: "Bash",
    command: "rm -rf /tmp/foo",
  });
});

test("resolved permissions emit permission-resolved items mapped per decision", () => {
  const items = mergeTimeline({
    events: [],
    chat: [],
    pending: [],
    resolved: [
      resolved("req-1", "allow"),
      resolved("req-2", "deny"),
      resolved("req-3", "expired"),
      resolved("req-4", "terminal"),
    ],
  });
  expect(items.map((i) => i.kind === "permission-resolved" && i.decision)).toEqual([
    "allowed",
    "denied",
    "expired",
    "expired",
  ]);
});

test("items are sorted by timestamp; chat (seconds) and events (ms) interleave correctly", () => {
  const items = mergeTimeline({
    events: [
      event(10, 1_700_000_001_000, { type: "session_start" }), // ms
      event(20, 1_700_000_003_000, { type: "tool_use" }),       // ms
    ],
    chat: [
      chat("m1", "pwa", "first", 1_700_000_000),                // s → 1_700_000_000_000 ms
      chat("m2", "claude", "second", 1_700_000_002),            // s → 1_700_000_002_000 ms
    ],
    pending: [],
    resolved: [],
  });
  expect(items.map((i) => i.id)).toEqual([
    "chat:m1",
    "event:10",
    "chat:m2",
    "event:20",
  ]);
});

test("ids are stable and deterministic — same input twice produces same ids", () => {
  const args = {
    events: [event(10, 1_700_000_001_000, { type: "x" })],
    chat: [chat("m1", "pwa", "hi", 1_700_000_000)],
    pending: [pending("req-1", 1_700_000_010)],
    resolved: [resolved("req-2", "allow")],
  };
  const a = mergeTimeline(args);
  const b = mergeTimeline(args);
  expect(a.map((i) => i.id)).toEqual(b.map((i) => i.id));
});
