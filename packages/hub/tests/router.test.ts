import { test, expect } from "bun:test";
import { Router } from "../src/router.ts";
import { DaemonRegistry, PwaRegistry } from "../src/connections.ts";

test("hello frame populates state and broadcasts daemon_online", () => {
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const broadcasts: unknown[] = [];
  const fakePwa = {} as object;
  preg.add(fakePwa, (f) => broadcasts.push(f));
  const router = new Router(dreg, preg);

  router.onDaemonFrame("d-1", {
    type: "hello",
    daemon_id: "d-1",
    epoch: 1,
    hostname: "macbook",
    agent_version: "0.1.0",
    sessions: [
      { session_id: "s1", tmux_session: "work", tmux_pane: "%0",
        cwd: "/x", model: "opus-4.7", pid: 1234, started_at: 1 }
    ]
  });

  expect(router.snapshot()).toEqual([
    { daemon_id: "d-1", hostname: "macbook", online: true,
      sessions: [{ session_id: "s1", tmux_session: "work", tmux_pane: "%0",
                   cwd: "/x", model: "opus-4.7", pid: 1234, started_at: 1 }]
    }
  ]);
  expect(broadcasts).toEqual([{
    type: "daemon_online", daemon_id: "d-1", hostname: "macbook",
    sessions: [{ session_id: "s1", tmux_session: "work", tmux_pane: "%0",
                 cwd: "/x", model: "opus-4.7", pid: 1234, started_at: 1 }]
  }]);
});

test("session_open broadcasts to PWAs", () => {
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const broadcasts: unknown[] = [];
  preg.add({}, (f) => broadcasts.push(f));
  const router = new Router(dreg, preg);

  router.onDaemonFrame("d-1", { type: "hello", daemon_id: "d-1", epoch: 1,
    hostname: "h", agent_version: "0", sessions: [] });
  broadcasts.length = 0;

  router.onDaemonFrame("d-1", {
    type: "session_open",
    session: { session_id: "s2", tmux_session: null, tmux_pane: null,
               cwd: "/y", model: "sonnet", pid: 99, started_at: 2 }
  });

  expect(broadcasts).toEqual([{
    type: "session_open",
    daemon_id: "d-1",
    session: { session_id: "s2", tmux_session: null, tmux_pane: null,
               cwd: "/y", model: "sonnet", pid: 99, started_at: 2 }
  }]);
});

test("daemon disconnect broadcasts daemon_offline and clears state", () => {
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const broadcasts: unknown[] = [];
  preg.add({}, (f) => broadcasts.push(f));
  const router = new Router(dreg, preg);

  router.onDaemonFrame("d-1", { type: "hello", daemon_id: "d-1", epoch: 1,
    hostname: "h", agent_version: "0", sessions: [] });
  broadcasts.length = 0;

  router.onDaemonDisconnect("d-1");
  expect(router.snapshot()).toEqual([]);
  expect(broadcasts).toEqual([{ type: "daemon_offline", daemon_id: "d-1" }]);
});

test("PWA subscribe receives current snapshot", () => {
  const dreg = new DaemonRegistry<unknown>();
  const preg = new PwaRegistry<unknown>();
  const router = new Router(dreg, preg);
  router.onDaemonFrame("d-1", { type: "hello", daemon_id: "d-1", epoch: 1,
    hostname: "h", agent_version: "0", sessions: [] });

  const sent: unknown[] = [];
  router.onPwaSubscribe((f) => sent.push(f));
  expect(sent).toEqual([{
    type: "snapshot",
    daemons: [{ daemon_id: "d-1", hostname: "h", online: true, sessions: [] }]
  }]);
});
