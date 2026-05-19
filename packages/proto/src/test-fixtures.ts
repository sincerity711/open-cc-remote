import type { SessionSnapshot } from "./frames.ts";

export function fixtureSession(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    session_id: "s1",
    claude_session_id: null,
    tmux_session: null,
    tmux_pane: null,
    cwd: "/x",
    model: null,
    pid: 1,
    started_at: 1,
    claude_client_version: "test",
    plugin_version: "0.1.0",
    ...overrides,
  };
}
