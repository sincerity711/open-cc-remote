import { test, expect } from "bun:test";
import { reducer, initialHubState, eventKey } from "./useHub";
import { selectSlashInventory } from "./useSlashInventory";
import type { PwaSlashInventory } from "@cc-remote/proto";

test("inbound slash_inventory frame is stored under (daemon_id, session_id)", () => {
  const frame: PwaSlashInventory = {
    type: "slash_inventory",
    daemon_id: "d-1",
    session_id: "s-1",
    entries: [
      { id: "builtin:clear", name: "/clear", source: "builtin" },
      { id: "skill:brainstorming", name: "/brainstorming", source: "skill" },
    ],
  };
  const after = reducer(initialHubState(), { type: "frame", frame });
  expect(after.slashInventory[eventKey("d-1", "s-1")]).toHaveLength(2);
  expect(selectSlashInventory(after, "d-1", "s-1").map((e) => e.name).sort())
    .toEqual(["/brainstorming", "/clear"]);
});

test("slash_inventory does not leak across sessions", () => {
  const a = reducer(initialHubState(), {
    type: "frame",
    frame: {
      type: "slash_inventory", daemon_id: "d-1", session_id: "s-1",
      entries: [{ id: "builtin:clear", name: "/clear", source: "builtin" }],
    },
  });
  const b = reducer(a, {
    type: "frame",
    frame: {
      type: "slash_inventory", daemon_id: "d-1", session_id: "s-2",
      entries: [],
    },
  });
  expect(selectSlashInventory(b, "d-1", "s-1")).toHaveLength(1);
  expect(selectSlashInventory(b, "d-1", "s-2")).toHaveLength(0);
});

test("selector returns empty array for unknown session", () => {
  const s = initialHubState();
  expect(selectSlashInventory(s, "d-x", "s-x")).toEqual([]);
});
