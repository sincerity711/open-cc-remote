import { test, expect } from "bun:test";
import { buildSession } from "../src/session.ts";
import type { SessionSnapshot } from "@cc-remote/proto";

test("buildSession reads env + generates UUID", () => {
  const env = {
    CLAUDE_PROJECT_DIR: "/Users/me/proj",
    TMUX_SESSION: "work",
    TMUX_PANE: "%0",
  };
  const s: SessionSnapshot = buildSession({ env, claudeClientVersion: "2.1.144", pluginVersion: "0.1.0", pid: 4242, now: 1700000000 });
  expect(s.session_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(s.cwd).toBe("/Users/me/proj");
  expect(s.tmux_session).toBe("work");
  expect(s.tmux_pane).toBe("%0");
  expect(s.claude_client_version).toBe("2.1.144");
  expect(s.plugin_version).toBe("0.1.0");
  expect(s.pid).toBe(4242);
  expect(s.started_at).toBe(1700000000);
  expect(s.claude_session_id).toBeNull();
  expect(s.model).toBeNull();
});

test("buildSession throws when CLAUDE_PROJECT_DIR is missing", () => {
  expect(() => buildSession({ env: {}, claudeClientVersion: "x", pluginVersion: "y", pid: 1, now: 0 })).toThrow(/CLAUDE_PROJECT_DIR/);
});

test("buildSession leaves tmux fields null when env is missing", () => {
  const s = buildSession({ env: { CLAUDE_PROJECT_DIR: "/x" }, claudeClientVersion: "v", pluginVersion: "p", pid: 1, now: 1 });
  expect(s.tmux_session).toBeNull();
  expect(s.tmux_pane).toBeNull();
});
