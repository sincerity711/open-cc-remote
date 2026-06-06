import { test, expect } from "bun:test";
import { reducer, initialHubState, eventKey } from "./useHub";
import { selectAgentCapabilities } from "./useAgentCapabilities";
import { selectSlashInventory } from "./useSlashInventory";
import type { PwaAgentHandshake } from "@cc-remote/proto";

const SAMPLE: PwaAgentHandshake = {
  type: "agent_handshake",
  daemon_id: "d-1",
  session_id: "s-1",
  agent_version: "2.1.165",
  available_modes: ["acceptEdits", "default", "bypassPermissions"],
  default_mode: "bypassPermissions",
  available_models: ["sonnet", "opus", "haiku"],
  available_commands: [
    { id: "builtin:clear", name: "/clear", source: "builtin" },
    { id: "skill:brainstorming", name: "/brainstorming", source: "skill" },
  ],
  capabilities: {
    supports_notification_hook: true,
    supports_ack: true,
    jsonl_flush_quirk: true,
    has_mcp: true,
    has_plugin: true,
  },
};

test("inbound agent_handshake is stored under (daemon_id, session_id)", () => {
  const after = reducer(initialHubState(), { type: "frame", frame: SAMPLE });
  expect(after.agentHandshakes[eventKey("d-1", "s-1")]).toBeDefined();
  const sel = selectAgentCapabilities(after, "d-1", "s-1");
  expect(sel).not.toBeNull();
  expect(sel!.agent_version).toBe("2.1.165");
  expect(sel!.default_mode).toBe("bypassPermissions");
  expect(sel!.capabilities.supports_ack).toBe(true);
});

test("agent_handshake mirrors available_commands into legacy slashInventory", () => {
  const after = reducer(initialHubState(), { type: "frame", frame: SAMPLE });
  const slash = selectSlashInventory(after, "d-1", "s-1");
  expect(slash.map((e) => e.name).sort()).toEqual(["/brainstorming", "/clear"]);
});

test("selectAgentCapabilities returns null for unknown session", () => {
  const s = initialHubState();
  expect(selectAgentCapabilities(s, "d-x", "s-x")).toBeNull();
});

test("agent_handshake does not leak across sessions", () => {
  const a = reducer(initialHubState(), { type: "frame", frame: SAMPLE });
  const b = reducer(a, {
    type: "frame",
    frame: { ...SAMPLE, session_id: "s-2", agent_version: "2.0.0" },
  });
  const aSel = selectAgentCapabilities(b, "d-1", "s-1");
  const bSel = selectAgentCapabilities(b, "d-1", "s-2");
  expect(aSel?.agent_version).toBe("2.1.165");
  expect(bSel?.agent_version).toBe("2.0.0");
});
