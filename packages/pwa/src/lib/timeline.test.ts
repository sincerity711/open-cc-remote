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
  test("emits 'agui' RenderItems for AGUIEvents in chronological order", () => {
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
      chat: [],
      pending: [],
      resolved: [],
    });
    expect(items.length).toBe(2);
    expect(items[0]?.tag).toBe("agui");
    expect(items[1]?.tag).toBe("agui");
  });

  test("interleaves pending permissions by timestamp", () => {
    const items = mergeTimeline({
      events: [],
      chat: [],
      pending: [
        {
          request_id: "p1",
          daemon_id: "d1",
          session_id: "s1",
          tool: "Bash",
          input: { command: "rm -rf /" },
          ts: 1500,
        } as any,
      ],
      resolved: [],
    });
    expect(items.length).toBe(1);
    expect(items[0]?.tag).toBe("permission-inline");
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
      chat: [],
      pending: [],
      resolved: [],
    });
    expect(items.length).toBe(1);
    expect(items[0]?.tag).toBe("agui");
  });
});
