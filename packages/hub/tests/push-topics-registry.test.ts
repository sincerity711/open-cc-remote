import { test, expect } from "bun:test";
import { PUSH_TOPICS, getTopic } from "../src/push-topics.ts";

test("registry exposes the 2 active topics with stable ids", () => {
  expect(PUSH_TOPICS.map((t) => t.id).sort()).toEqual(
    ["idle", "permission"],
  );
});

test("permission is default-enabled and bypasses DND; idle is opt-in", () => {
  expect(getTopic("permission").default_enabled).toBe(true);
  expect(getTopic("permission").bypass_dnd).toBe(true);
  expect(getTopic("idle").default_enabled).toBe(false);
  expect(getTopic("idle").bypass_dnd).toBe(false);
});

test("getTopic throws on unknown id (including the legacy 'completed' / 'offline')", () => {
  expect(() => getTopic("nope")).toThrow(/unknown topic/);
  expect(() => getTopic("completed")).toThrow(/unknown topic/);
  expect(() => getTopic("offline")).toThrow(/unknown topic/);
});
