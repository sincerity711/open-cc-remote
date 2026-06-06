import { test, expect } from "bun:test";
import { EventType, type AGUIEvent } from "@cc-remote/proto";
import { computeReasoningStatus } from "./reasoning-status";
import type { RenderItem } from "../screens/timeline/types";

function reasoning(id: string, ts = 0): RenderItem {
  return {
    tag: "agui",
    id,
    ts,
    event: {
      type: EventType.REASONING_MESSAGE_CHUNK,
      messageId: id,
      delta: "thinking…",
    } as unknown as AGUIEvent,
  };
}

function text(id: string, ts = 0): RenderItem {
  return {
    tag: "agui",
    id,
    ts,
    event: {
      type: EventType.TEXT_MESSAGE_CHUNK,
      messageId: id,
      role: "assistant",
      delta: "hello",
    } as unknown as AGUIEvent,
  };
}

function runFinished(id: string, ts = 0): RenderItem {
  return {
    tag: "agui",
    id,
    ts,
    event: { type: EventType.RUN_FINISHED } as unknown as AGUIEvent,
  };
}

function tool(id: string, ts = 0): RenderItem {
  return {
    tag: "tool",
    id,
    ts,
    chunk: {
      type: EventType.TOOL_CALL_CHUNK,
      toolCallId: id,
      toolCallName: "Bash",
      delta: "echo",
    } as unknown as RenderItem extends { chunk: infer C } ? C : never,
  } as RenderItem;
}

test("computeReasoningStatus — empty input → empty map", () => {
  const map = computeReasoningStatus([]);
  expect(map.size).toBe(0);
});

test("computeReasoningStatus — single reasoning item → active", () => {
  const map = computeReasoningStatus([reasoning("r1")]);
  expect(map.get("r1")).toBe("active");
});

test("computeReasoningStatus — reasoning followed by text → done", () => {
  const map = computeReasoningStatus([reasoning("r1"), text("t1")]);
  expect(map.get("r1")).toBe("done");
});

test("computeReasoningStatus — reasoning followed by RUN_FINISHED only → still active", () => {
  // FSM markers don't flip status.
  const map = computeReasoningStatus([reasoning("r1"), runFinished("rf1")]);
  expect(map.get("r1")).toBe("active");
});

test("computeReasoningStatus — two reasonings then text → both done", () => {
  const map = computeReasoningStatus([
    reasoning("r1"),
    reasoning("r2"),
    text("t1"),
  ]);
  expect(map.get("r1")).toBe("done");
  expect(map.get("r2")).toBe("done");
});

test("computeReasoningStatus — reasoning, tool, reasoning → first done, second active", () => {
  const map = computeReasoningStatus([
    reasoning("r1"),
    tool("tool1"),
    reasoning("r2"),
  ]);
  expect(map.get("r1")).toBe("done");
  expect(map.get("r2")).toBe("active");
});

test("computeReasoningStatus — reasoning followed by permission-resolved → done", () => {
  const map = computeReasoningStatus([
    reasoning("r1"),
    {
      tag: "permission-resolved",
      id: "p1",
      ts: 0,
      resolved: { decision: "allow" } as unknown as RenderItem extends {
        resolved: infer R;
      }
        ? R
        : never,
    } as RenderItem,
  ]);
  expect(map.get("r1")).toBe("done");
});
