import { test, expect } from "bun:test";
import { handleCliCommand } from "../src/cli-command.ts";

test("invokes tmux send-keys with the pane id when present", () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const spawn = (cmd: string, args: string[]) => { calls.push({ cmd, args }); };
  handleCliCommand(
    { type: "cli_command", session_id: "s1", text: "/clear", user: "u@x" },
    {
      lookupPane: (id) => id === "s1" ? { tmux_pane: "%5", tmux_session: "demo" } : null,
      spawn,
      log: () => {},
    },
  );
  expect(calls).toHaveLength(1);
  expect(calls[0]!.cmd).toBe("tmux");
  expect(calls[0]!.args).toEqual(["send-keys", "-t", "%5", "/clear", "Enter"]);
});

test("falls back to session name when pane is null", () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  handleCliCommand(
    { type: "cli_command", session_id: "s1", text: "/compact", user: "u@x" },
    {
      lookupPane: () => ({ tmux_pane: null, tmux_session: "demo-claude" }),
      spawn: (cmd, args) => { calls.push({ cmd, args }); },
      log: () => {},
    },
  );
  expect(calls).toHaveLength(1);
  expect(calls[0]!.args).toEqual(["send-keys", "-t", "demo-claude", "/compact", "Enter"]);
});

test("logs and skips if both pane and session are null", () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const logs: string[] = [];
  handleCliCommand(
    { type: "cli_command", session_id: "s1", text: "/clear", user: "u@x" },
    {
      lookupPane: () => ({ tmux_pane: null, tmux_session: null }),
      spawn: (cmd, args) => { calls.push({ cmd, args }); },
      log: (m) => { logs.push(m); },
    },
  );
  expect(calls).toHaveLength(0);
  expect(logs.some((l) => l.includes("no tmux target"))).toBe(true);
});

test("logs and skips when session unknown", () => {
  const logs: string[] = [];
  const calls: Array<unknown> = [];
  handleCliCommand(
    { type: "cli_command", session_id: "missing", text: "/clear", user: "u@x" },
    {
      lookupPane: () => null,
      spawn: () => { calls.push(true); },
      log: (m) => { logs.push(m); },
    },
  );
  expect(calls).toHaveLength(0);
  expect(logs.some((l) => l.includes("unknown session"))).toBe(true);
});
