import { expect, test } from "bun:test";
import type {
  DaemonView,
  EventFrameForPwa,
  PwaPermissionRequest,
} from "@cc-remote/proto";
import { computeDaemonViewModels } from "../src/lib/daemonViewModel";

const baseSession = {
  session_id: "s1",
  claude_session_id: null,
  tmux_session: null,
  tmux_pane: null,
  cwd: "/work/repo",
  model: "sonnet",
  pid: 0,
  started_at: 0,
  claude_client_version: "1.0.0",
  plugin_version: "0.0.1",
};

const onlineDaemon: DaemonView = {
  daemon_id: "d1",
  hostname: "mbp.local",
  online: true,
  sessions: [baseSession],
};

const offlineDaemon: DaemonView = {
  daemon_id: "d2",
  hostname: "dev-vm-eu",
  online: false,
  sessions: [{ ...baseSession, session_id: "s2", cwd: "/srv/api" }],
};

test("offline daemon yields offline state for every session", () => {
  const models = computeDaemonViewModels({
    daemons: [offlineDaemon],
    events: {},
    pendingPermissions: {},
    completedCounts: {},
    idleSessions: {},
  });
  expect(models).toHaveLength(1);
  expect(models[0].online).toBe(false);
  expect(models[0].sessions[0].state).toBe("offline");
});

test("session with a pending permission is in waiting state with permission activity", () => {
  const pending: PwaPermissionRequest = {
    type: "permission_request",
    daemon_id: "d1",
    session_id: "s1",
    request_id: "r1",
    tool: "Bash",
    args_summary: "rm -rf x",
    expires_at: 0,
  };
  const models = computeDaemonViewModels({
    daemons: [onlineDaemon],
    events: {},
    pendingPermissions: { r1: pending },
    completedCounts: {},
    idleSessions: {},
  });
  expect(models[0].sessions[0].state).toBe("waiting");
  expect(models[0].sessions[0].activity).toContain("permission");
});

test("idle flag wins over event activity when set", () => {
  const evt: EventFrameForPwa = {
    type: "event",
    daemon_id: "d1",
    session_id: "s1",
    jsonl_offset: 1,
    ts: 1,
    payload: {},
  };
  const models = computeDaemonViewModels({
    daemons: [onlineDaemon],
    events: { "d1::s1": [evt] },
    pendingPermissions: {},
    completedCounts: {},
    idleSessions: { "d1::s1": true },
  });
  expect(models[0].sessions[0].state).toBe("idle");
});

test("session with events but no pending/idle is working", () => {
  const evt: EventFrameForPwa = {
    type: "event",
    daemon_id: "d1",
    session_id: "s1",
    jsonl_offset: 1,
    ts: 1,
    payload: {},
  };
  const models = computeDaemonViewModels({
    daemons: [onlineDaemon],
    events: { "d1::s1": [evt] },
    pendingPermissions: {},
    completedCounts: { "d1::s1": 2 },
    idleSessions: {},
  });
  expect(models[0].sessions[0].state).toBe("working");
  expect(models[0].sessions[0].tasks).toBe(2);
  expect(models[0].sessions[0].unread).toBe(1);
});

test("daemon with zero sessions still appears in the model list", () => {
  const empty: DaemonView = {
    daemon_id: "d3",
    hostname: "fresh.local",
    online: true,
    sessions: [],
  };
  const models = computeDaemonViewModels({
    daemons: [empty],
    events: {},
    pendingPermissions: {},
    completedCounts: {},
    idleSessions: {},
  });
  expect(models[0].sessions).toEqual([]);
});

test("name derives from cwd basename (so users see 'repo' not a raw UUID)", () => {
  const models = computeDaemonViewModels({
    daemons: [onlineDaemon],
    events: {},
    pendingPermissions: {},
    completedCounts: {},
    idleSessions: {},
  });
  // baseSession.cwd === "/work/repo"
  expect(models[0].sessions[0].name).toBe("repo");
});

test("name falls back to short session_id when cwd is empty or root", () => {
  const noCwd: DaemonView = {
    daemon_id: "d1",
    hostname: "mbp.local",
    online: true,
    sessions: [{ ...baseSession, cwd: "" }],
  };
  const rootCwd: DaemonView = {
    daemon_id: "d1",
    hostname: "mbp.local",
    online: true,
    sessions: [{ ...baseSession, session_id: "abcdef1234567890", cwd: "/" }],
  };
  const a = computeDaemonViewModels({
    daemons: [noCwd],
    events: {},
    pendingPermissions: {},
    completedCounts: {},
    idleSessions: {},
  });
  const b = computeDaemonViewModels({
    daemons: [rootCwd],
    events: {},
    pendingPermissions: {},
    completedCounts: {},
    idleSessions: {},
  });
  // first 8 chars of session_id, no full UUIDs leaked
  expect(a[0].sessions[0].name).toBe(baseSession.session_id.slice(0, 8));
  expect(b[0].sessions[0].name).toBe("abcdef12");
});
