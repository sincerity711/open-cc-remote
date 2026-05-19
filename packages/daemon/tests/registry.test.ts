import { test, expect } from "bun:test";
import { LiveSessions } from "../src/registry.ts";
import { fixtureSession } from "@cc-remote/proto";

const make = (id: string) => fixtureSession({ session_id: id });

test("add/get/remove", () => {
  const reg = new LiveSessions();
  reg.add(make("a"));
  expect(reg.get("a")?.session_id).toBe("a");
  expect(reg.list()).toHaveLength(1);
  reg.remove("a");
  expect(reg.get("a")).toBeUndefined();
});

test("emits onAdd / onRemove", () => {
  const reg = new LiveSessions();
  const added: string[] = []; const removed: string[] = [];
  reg.onAdd((s) => added.push(s.session_id));
  reg.onRemove((id) => removed.push(id));
  reg.add(make("x"));
  reg.remove("x");
  expect(added).toEqual(["x"]);
  expect(removed).toEqual(["x"]);
});

test("ignores duplicate add of same session_id", () => {
  const reg = new LiveSessions();
  let count = 0; reg.onAdd(() => count++);
  reg.add(make("a"));
  reg.add(make("a"));
  expect(count).toBe(1);
  expect(reg.list()).toHaveLength(1);
});
