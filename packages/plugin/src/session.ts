import { randomUUID } from "node:crypto";
import type { SessionSnapshot } from "@cc-remote/proto";

export interface BuildSessionInput {
  env: Record<string, string | undefined>;
  claudeClientVersion: string;
  pluginVersion: string;
  pid: number;
  now: number;                  // unix seconds
}

export function buildSession(i: BuildSessionInput): SessionSnapshot {
  const cwd = i.env.CLAUDE_PROJECT_DIR;
  if (!cwd) throw new Error("buildSession: CLAUDE_PROJECT_DIR is required (Claude Code should set this; if unset, you're running the plugin in the wrong context)");

  return {
    session_id: randomUUID(),
    claude_session_id: null,
    tmux_session: i.env.TMUX_SESSION ? i.env.TMUX_SESSION : null,
    tmux_pane: i.env.TMUX_PANE ? i.env.TMUX_PANE : null,
    cwd,
    model: null,
    pid: i.pid,
    started_at: i.now,
    claude_client_version: i.claudeClientVersion,
    plugin_version: i.pluginVersion,
  };
}
