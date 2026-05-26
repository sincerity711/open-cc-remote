import { expect, test } from "bun:test";
import type {
  DaemonView,
  EventFrameForPwa,
  PwaPermissionRequest,
  SessionState,
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
  state: "idle" as SessionState,
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
  sessions: [{ ...baseSession, session_id: "s2", cwd: "/srv/api", state: "working" }],
};

test("offline daemon yields offline state for every session regardless of fsm state", () => {
  const models = computeDaemonViewModels({
    daemons: [offlineDaemon],
    events: {},
    pendingPermissions: {},
    completedCounts: {},
  });
  expect(models).toHaveLength(1);
  expect(models[0].online).toBe(false);
  expect(models[0].sessions[0].state).toBe("offline");
});

test("session.state from daemon FSM is rendered directly when online", () => {
  const working: DaemonView = {
    ...onlineDaemon,
    sessions: [{ ...baseSession, state: "working" }],
  };
  const waiting: DaemonView = {
    ...onlineDaemon,
    sessions: [{ ...baseSession, state: "waiting" }],
  };
  const idle: DaemonView = {
    ...onlineDaemon,
    sessions: [{ ...baseSession, state: "idle" }],
  };
  expect(
    computeDaemonViewModels({
      daemons: [working], events: {}, pendingPermissions: {}, completedCounts: {},
    })[0].sessions[0].state,
  ).toBe("working");
  expect(
    computeDaemonViewModels({
      daemons: [waiting], events: {}, pendingPermissions: {}, completedCounts: {},
    })[0].sessions[0].state,
  ).toBe("waiting");
  expect(
    computeDaemonViewModels({
      daemons: [idle], events: {}, pendingPermissions: {}, completedCounts: {},
    })[0].sessions[0].state,
  ).toBe("idle");
});

test("history-replayed events do NOT flip an idle session to working — daemon FSM is the source of truth", () => {
  // Simulates the bug: PWA enters a session, requests history, gets ts=0 events back.
  // Pre-FSM the heuristic was events.length > 0 → working. Now state stays whatever the daemon says.
  const historicEvents: EventFrameForPwa[] = [
    { type: "event", daemon_id: "d1", session_id: "s1", jsonl_offset: 1, payload: {} },
    { type: "event", daemon_id: "d1", session_id: "s1", jsonl_offset: 2, payload: {} },
  ];
  const models = computeDaemonViewModels({
    daemons: [onlineDaemon], // baseSession.state === "idle"
    events: { "d1::s1": historicEvents },
    pendingPermissions: {},
    completedCounts: {},
  });
  expect(models[0].sessions[0].state).toBe("idle");
  // No lastSeenOffsets passed → every buffered event is treated as unread.
  expect(models[0].sessions[0].unread).toBe(2);
});

test("unread filters by jsonl_offset > lastSeenOffsets[k] (events at or below the anchor are read)", () => {
  const events: EventFrameForPwa[] = [
    { type: "event", daemon_id: "d1", session_id: "s1", jsonl_offset: 10, payload: {} },
    { type: "event", daemon_id: "d1", session_id: "s1", jsonl_offset: 20, payload: {} },
    { type: "event", daemon_id: "d1", session_id: "s1", jsonl_offset: 30, payload: {} },
  ];
  const at20 = computeDaemonViewModels({
    daemons: [onlineDaemon],
    events: { "d1::s1": events },
    pendingPermissions: {},
    completedCounts: {},
    lastSeenOffsets: { "d1::s1": 20 },
  });
  expect(at20[0].sessions[0].unread).toBe(1);

  const at30 = computeDaemonViewModels({
    daemons: [onlineDaemon],
    events: { "d1::s1": events },
    pendingPermissions: {},
    completedCounts: {},
    lastSeenOffsets: { "d1::s1": 30 },
  });
  expect(at30[0].sessions[0].unread).toBe(0);

  // Older history backfilled (offsets < anchor) does not bump unread.
  const olderHistory: EventFrameForPwa[] = [
    { type: "event", daemon_id: "d1", session_id: "s1", jsonl_offset: 1, payload: {} },
    { type: "event", daemon_id: "d1", session_id: "s1", jsonl_offset: 2, payload: {} },
    ...events,
  ];
  const withHistory = computeDaemonViewModels({
    daemons: [onlineDaemon],
    events: { "d1::s1": olderHistory },
    pendingPermissions: {},
    completedCounts: {},
    lastSeenOffsets: { "d1::s1": 30 },
  });
  expect(withHistory[0].sessions[0].unread).toBe(0);
});

test("waiting state surfaces 'permission needed' activity when a pending request exists", () => {
  const pending: PwaPermissionRequest = {
    type: "permission_request",
    daemon_id: "d1",
    session_id: "s1",
    request_id: "r1",
    tool: "Bash",
    args_summary: "rm -rf x",
    expires_at: 0,
  };
  const waiting: DaemonView = {
    ...onlineDaemon,
    sessions: [{ ...baseSession, state: "waiting" }],
  };
  const models = computeDaemonViewModels({
    daemons: [waiting],
    events: {},
    pendingPermissions: { r1: pending },
    completedCounts: {},
  });
  expect(models[0].sessions[0].state).toBe("waiting");
  expect(models[0].sessions[0].activity).toContain("permission");
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
  });
  expect(models[0].sessions).toEqual([]);
});

test("name derives from cwd basename (so users see 'repo' not a raw UUID)", () => {
  const models = computeDaemonViewModels({
    daemons: [onlineDaemon],
    events: {},
    pendingPermissions: {},
    completedCounts: {},
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
  });
  const b = computeDaemonViewModels({
    daemons: [rootCwd],
    events: {},
    pendingPermissions: {},
    completedCounts: {},
  });
  // first 8 chars of session_id, no full UUIDs leaked
  expect(a[0].sessions[0].name).toBe(baseSession.session_id.slice(0, 8));
  expect(b[0].sessions[0].name).toBe("abcdef12");
});
