import { describe, expect, test } from "bun:test";
import { EventType, type ToolCallResultEvent } from "@cc-remote/proto";
import {
  toolStatusFromResult,
  formatDuration,
  riskFromToolName,
} from "./view-helpers";

describe("view-helpers", () => {
  test("toolStatusFromResult reads rawEvent.is_error first", () => {
    const ev: ToolCallResultEvent = {
      type: EventType.TOOL_CALL_RESULT,
      messageId: "m1",
      toolCallId: "t1",
      content: "anything",
      rawEvent: { is_error: true },
    } as ToolCallResultEvent;
    expect(toolStatusFromResult(ev)).toBe("failure");
  });

  test("toolStatusFromResult falls back to content heuristic when no rawEvent", () => {
    const ev: ToolCallResultEvent = {
      type: EventType.TOOL_CALL_RESULT,
      messageId: "m1",
      toolCallId: "t1",
      content: "Error: not found",
    } as ToolCallResultEvent;
    expect(toolStatusFromResult(ev)).toBe("failure");
  });

  test("toolStatusFromResult returns success when neither flag fires", () => {
    const ev: ToolCallResultEvent = {
      type: EventType.TOOL_CALL_RESULT,
      messageId: "m1",
      toolCallId: "t1",
      content: "files: a.ts, b.ts",
    } as ToolCallResultEvent;
    expect(toolStatusFromResult(ev)).toBe("success");
  });

  test("toolStatusFromResult returns success when rawEvent.is_error === false (overrides content)", () => {
    const ev: ToolCallResultEvent = {
      type: EventType.TOOL_CALL_RESULT,
      messageId: "m1",
      toolCallId: "t1",
      content: "Error: but rawEvent says success",
      rawEvent: { is_error: false },
    } as ToolCallResultEvent;
    expect(toolStatusFromResult(ev)).toBe("success");
  });

  test("formatDuration", () => {
    expect(formatDuration(0, 800)).toBe("0.8s");
    expect(formatDuration(0, 12_000)).toBe("12s");
    expect(formatDuration(undefined, undefined)).toBe("");
    expect(formatDuration(0, 0)).toBe("0.0s");
  });

  test("riskFromToolName", () => {
    expect(riskFromToolName("Bash")).toBe("warning");
    expect(riskFromToolName("Edit")).toBe("warning");
    expect(riskFromToolName("Write")).toBe("warning");
    expect(riskFromToolName("MultiEdit")).toBe("warning");
    expect(riskFromToolName("Read")).toBeUndefined();
    expect(riskFromToolName("")).toBeUndefined();
  });
});
