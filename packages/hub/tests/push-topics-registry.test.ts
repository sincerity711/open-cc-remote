import { test, expect } from "bun:test";
import { PUSH_TOPICS, getTopic } from "../src/push-topics.ts";

test("registry exposes the 4 baseline topics with stable ids", () => {
  expect(PUSH_TOPICS.map((t) => t.id).sort()).toEqual(
    ["completed", "idle", "offline", "permission"],
  );
});

test("permission is default-enabled and bypasses DND; others are not", () => {
  expect(getTopic("permission").default_enabled).toBe(true);
  expect(getTopic("permission").bypass_dnd).toBe(true);
  for (const id of ["offline", "completed", "idle"]) {
    expect(getTopic(id).default_enabled).toBe(false);
    expect(getTopic(id).bypass_dnd).toBe(false);
  }
});

test("getTopic throws on unknown id", () => {
  expect(() => getTopic("nope")).toThrow(/unknown topic/);
});
