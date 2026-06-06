import { describe, expect, test } from "bun:test";
import { EventType } from "@cc-remote/proto";
import { mergeTimeline } from "./timeline";
import type { BufferedEvent } from "../hooks/useHub";

const be = (jsonl_offset: number, event_index: number, event: any, ts = 1000): BufferedEvent => ({
  daemon_id: "d1",
  session_id: "s1",
  jsonl_offset,
  event_index,
  ts,
  event,
});

describe("mergeTimeline", () => {
  test("emits items for AGUIEvents in chronological order — TOOL_CALL_CHUNK becomes a 'tool' RenderItem", () => {
    const items = mergeTimeline({
      events: [
        be(100, 0, {
          type: EventType.TEXT_MESSAGE_CHUNK,
          messageId: "m1",
          role: "assistant",
          delta: "hello",
        }, 1000),
        be(200, 0, {
          type: EventType.TOOL_CALL_CHUNK,
          toolCallId: "t1",
          toolCallName: "Bash",
          delta: '{"command":"ls"}',
        }, 2000),
      ],
      resolved: [],
      askResolved: [],
    });
    expect(items.length).toBe(2);
    expect(items[0]?.tag).toBe("agui");
    expect(items[1]?.tag).toBe("tool");
  });

  test("filters RAW events whose underlying JSONL type is in HIDDEN_PAYLOAD_TYPES", () => {
    const items = mergeTimeline({
      events: [
        be(100, 0, {
          type: EventType.RAW,
          source: "claude-code-jsonl",
          event: { type: "summary", text: "noise" },
        }, 1000),
        be(200, 0, {
          type: EventType.TEXT_MESSAGE_CHUNK,
          messageId: "m1",
          role: "assistant",
          delta: "real prose",
        }, 2000),
      ],
      resolved: [],
      askResolved: [],
    });
    expect(items.length).toBe(1);
    expect(items[0]?.tag).toBe("agui");
  });

  test("merges TOOL_CALL_CHUNK + TOOL_CALL_RESULT into a single 'tool' RenderItem", () => {
    const items = mergeTimeline({
      events: [
        be(100, 0, {
          type: EventType.TOOL_CALL_CHUNK,
          toolCallId: "t1",
          toolCallName: "Bash",
          delta: '{"command":"ls"}',
        }, 1000),
        be(110, 0, {
          type: EventType.TOOL_CALL_RESULT,
          messageId: "m1",
          toolCallId: "t1",
          content: "file1\nfile2",
        }, 2000),
      ],
      resolved: [],
      askResolved: [],
    });
    expect(items.length).toBe(1);
    expect(items[0]?.tag).toBe("tool");
    if (items[0]?.tag === "tool") {
      expect(items[0].chunk.toolCallId).toBe("t1");
      expect(items[0].result?.toolCallId).toBe("t1");
      expect(items[0].ts).toBe(1000); // pinned to chunk's ts
    }
  });

  test("orphaned TOOL_CALL_CHUNK (no result yet) emits a 'tool' item with result undefined", () => {
    const items = mergeTimeline({
      events: [
        be(100, 0, {
          type: EventType.TOOL_CALL_CHUNK,
          toolCallId: "t1",
          toolCallName: "Bash",
          delta: '{"command":"ls"}',
        }, 1000),
      ],
      resolved: [],
      askResolved: [],
    });
    expect(items.length).toBe(1);
    expect(items[0]?.tag).toBe("tool");
    if (items[0]?.tag === "tool") expect(items[0].result).toBeUndefined();
  });

  test("emits ask-question-resolved RenderItem from askResolved input", () => {
    const items = mergeTimeline({
      events: [],
      resolved: [],
      askResolved: [
        {
          type: "ask_user_question_resolved",
          daemon_id: "d", session_id: "s",
          request_id: "ask-x",
          resolution: "answered",
        } as any,
      ],
    });
    expect(items.length).toBe(1);
    expect(items[0]?.tag).toBe("ask-question-resolved");
    if (items[0]?.tag === "ask-question-resolved") {
      expect(items[0].id).toBe("ask-resolved:ask-x");
      expect(items[0].resolved.resolution).toBe("answered");
    }
  });

  test("emits permission-resolved RenderItem from resolved input", () => {
    const items = mergeTimeline({
      events: [],
      resolved: [
        {
          type: "permission_resolved",
          daemon_id: "d", session_id: "s",
          request_id: "p-x",
          decision: "allow", decided_via: "pwa",
        } as any,
      ],
      askResolved: [],
    });
    expect(items.length).toBe(1);
    expect(items[0]?.tag).toBe("permission-resolved");
    if (items[0]?.tag === "permission-resolved") {
      expect(items[0].id).toBe("perm-resolved:p-x");
    }
  });
});
