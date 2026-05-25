/**
 * Legacy timeline integration tests — updated for Phase D.3.
 *
 * The old mergeTimeline consumed EventFrameForPwa[] and emitted TimelineEvent[].
 * It has been rewritten to consume BufferedEvent[] and emit RenderItem[].
 * These tests now verify the new contract.
 */
import { expect, test, describe } from "bun:test";
import type {
  PwaChatBroadcast,
  PwaPermissionRequest,
  PwaPermissionResolved,
} from "@cc-remote/proto";
import { EventType } from "@cc-remote/proto";
import { mergeTimeline } from "../src/lib/timeline";
import type { BufferedEvent } from "../src/hooks/useHub";

const D = "daemon-1";
const S = "session-1";

function be(
  jsonl_offset: number,
  event_index: number,
  event: BufferedEvent["event"],
  ts = 1_700_000_000_000,
): BufferedEvent {
  return { daemon_id: D, session_id: S, jsonl_offset, event_index, ts, event };
}

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

test("BufferedEvents emit 'agui' RenderItems", () => {
  const items = mergeTimeline({
    events: [
      be(10, 0, { type: EventType.TEXT_MESSAGE_CHUNK, messageId: "m1", role: "assistant", delta: "hello" }),
      be(20, 0, { type: EventType.TOOL_CALL_CHUNK, toolCallId: "t1", toolCallName: "Bash", delta: '{"command":"ls"}' }),
    ],
    chat: [],
    pending: [],
    resolved: [],
  });
  expect(items).toHaveLength(2);
  expect(items[0]?.tag).toBe("agui");
  expect(items[1]?.tag).toBe("agui");
});

test("chat broadcasts emit 'chat' RenderItems", () => {
  const items = mergeTimeline({
    events: [],
    chat: [
      chat("m1", "pwa", "hello", 1_700_000_000_000),
      chat("m2", "claude", "hi", 1_700_000_001_000),
    ],
    pending: [],
    resolved: [],
  });
  expect(items).toHaveLength(2);
  expect(items[0]?.tag).toBe("chat");
  expect(items[1]?.tag).toBe("chat");
});

describe("RAW event filtering", () => {
  const hiddenTypes = [
    "attachment",
    "summary",
    "queue-operation",
    "mcp_instructions_data",
    "ai-title",
    "last-prompt",
    "permission-mode",
    "pr-link",
  ];
  for (const type of hiddenTypes) {
    test(`RAW event with inner JSONL type "${type}" is dropped`, () => {
      const items = mergeTimeline({
        events: [
          be(10, 0, { type: EventType.RAW, source: "claude-code-jsonl", event: { type } } as any),
        ],
        chat: [],
        pending: [],
        resolved: [],
      });
      expect(items).toHaveLength(0);
    });
  }

  test("RAW event with non-hidden inner type is kept", () => {
    const items = mergeTimeline({
      events: [
        be(10, 0, { type: EventType.RAW, source: "claude-code-jsonl", event: { type: "session_start" } } as any),
      ],
      chat: [],
      pending: [],
      resolved: [],
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.tag).toBe("agui");
  });
});

test("pending permissions emit 'permission-inline' items", () => {
  const items = mergeTimeline({
    events: [],
    chat: [],
    pending: [pending("req-1", 1_700_000_010)],
    resolved: [],
  });
  expect(items).toHaveLength(1);
  expect(items[0]?.tag).toBe("permission-inline");
  if (items[0]?.tag === "permission-inline") {
    expect(items[0].pending.tool).toBe("Bash");
  }
});

test("resolved permissions emit 'permission-resolved' items", () => {
  const items = mergeTimeline({
    events: [],
    chat: [],
    pending: [],
    resolved: [
      resolved("req-1", "allow"),
      resolved("req-2", "deny"),
    ],
  });
  expect(items).toHaveLength(2);
  expect(items[0]?.tag).toBe("permission-resolved");
  expect(items[1]?.tag).toBe("permission-resolved");
});

test("items are sorted by timestamp", () => {
  const items = mergeTimeline({
    events: [
      be(10, 0, { type: EventType.TEXT_MESSAGE_CHUNK, messageId: "m1", role: "assistant", delta: "a" }, 1_700_000_001_000),
      be(20, 0, { type: EventType.TEXT_MESSAGE_CHUNK, messageId: "m2", role: "assistant", delta: "c" }, 1_700_000_003_000),
    ],
    chat: [
      chat("m3", "pwa", "b", 1_700_000_002_000),
    ],
    pending: [],
    resolved: [],
  });
  expect(items).toHaveLength(3);
  expect(items[0]?.tag).toBe("agui");   // ts 1_700_000_001_000
  expect(items[1]?.tag).toBe("chat");   // ts 1_700_000_002_000
  expect(items[2]?.tag).toBe("agui");   // ts 1_700_000_003_000
});

test("ids are stable and deterministic — same input twice produces same ids", () => {
  const args = {
    events: [
      be(10, 0, { type: EventType.TEXT_MESSAGE_CHUNK, messageId: "m1", role: "assistant", delta: "x" }),
    ],
    chat: [chat("m1", "pwa", "hi", 1_700_000_000)],
    pending: [pending("req-1", 1_700_000_010)],
    resolved: [resolved("req-2", "allow")],
  };
  const a = mergeTimeline(args);
  const b = mergeTimeline(args);
  expect(a.map((i) => i.id)).toEqual(b.map((i) => i.id));
});

test("agui item id encodes daemon_id, session_id, jsonl_offset, event_index", () => {
  const items = mergeTimeline({
    events: [be(42, 3, { type: EventType.TEXT_MESSAGE_CHUNK, messageId: "m1", role: "assistant", delta: "x" })],
    chat: [],
    pending: [],
    resolved: [],
  });
  expect(items[0]?.id).toBe(`evt:${D}:${S}:42:3`);
});
