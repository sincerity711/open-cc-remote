import { describe, expect, test } from "bun:test";
import { EventType } from "@cc-remote/proto";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code";

describe("ClaudeCodeAdapter", () => {
  test("convertRow returns AGUIEvent[] for a tool_result row with is_error", () => {
    const adapter = new ClaudeCodeAdapter();
    const row = {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "err", is_error: true },
        ],
      },
    };
    const events = adapter.convertRow(row, { sessionId: "s1", jsonlOffset: 100 });
    expect(events.length).toBeGreaterThan(0);
    const result = events.find((e) => e.type === EventType.TOOL_CALL_RESULT);
    expect(result).toBeDefined();
    const raw = (result as { rawEvent: { is_error: boolean } }).rawEvent;
    expect(raw.is_error).toBe(true);
  });

  test("convertRow returns [] for a malformed row without throwing", () => {
    const adapter = new ClaudeCodeAdapter();
    expect(() => adapter.convertRow(null, { sessionId: "s1", jsonlOffset: 0 })).not.toThrow();
    expect(adapter.convertRow(null, { sessionId: "s1", jsonlOffset: 0 })).toEqual([]);
  });
});
