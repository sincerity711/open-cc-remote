import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DaemonViewModel } from "../src/lib/daemonViewModel";
import { HomeScreen } from "../src/screens/HomeScreen";

const onlineDaemon: DaemonViewModel = {
  daemon_id: "d1",
  hostname: "mbp.local",
  online: true,
  sessions: [
    {
      daemon_id: "d1",
      session_id: "s1",
      name: "s1",
      model: "sonnet",
      cwd: "/work/repo",
      activity: "permission needed (Bash)",
      state: "waiting",
      unread: 3,
      tasks: 2,
    },
  ],
};

const offlineDaemon: DaemonViewModel = {
  daemon_id: "d2",
  hostname: "vm-eu",
  online: false,
  sessions: [
    {
      daemon_id: "d2",
      session_id: "s2",
      name: "s2",
      model: "opus",
      cwd: "/srv/api",
      activity: "offline",
      state: "offline",
      unread: 0,
      tasks: 0,
    },
  ],
};

test("HomeScreen renders mini card, online daemon, and offline daemon", () => {
  const markup = renderToStaticMarkup(
    <HomeScreen
      daemons={[onlineDaemon, offlineDaemon]}
      pendingApprovalsCount={1}
      topPendingPreview={{
        daemonHostname: "mbp.local",
        sessionName: "s1",
        tool: "Bash",
        commandSummary: "rm -rf node_modules",
      }}
      onSelectSession={() => {}}
      onStartSession={() => {}}
      onKillSession={() => {}}
      onOpenPermission={() => {}}
    />,
  );
  expect(markup).toContain("1 approval waiting");
  expect(markup).toContain("rm -rf node_modules");
  expect(markup).toContain("mbp.local");
  expect(markup).toContain("vm-eu");
  expect(markup).toContain("Waiting");
  expect(markup).toContain("Offline");
  expect(markup).toContain('data-testid="machine-card-d1"');
  expect(markup).toContain('data-testid="sessions-d1"');
});

test("HomeScreen omits mini card when no approvals are pending", () => {
  const markup = renderToStaticMarkup(
    <HomeScreen
      daemons={[onlineDaemon]}
      pendingApprovalsCount={0}
      onSelectSession={() => {}}
      onStartSession={() => {}}
      onKillSession={() => {}}
      onOpenPermission={() => {}}
    />,
  );
  expect(markup).not.toContain("permission-mini");
});

test("HomeScreen shows the empty-state hint when no daemons are connected", () => {
  const markup = renderToStaticMarkup(
    <HomeScreen
      daemons={[]}
      pendingApprovalsCount={0}
      onSelectSession={() => {}}
      onStartSession={() => {}}
      onKillSession={() => {}}
      onOpenPermission={() => {}}
    />,
  );
  expect(markup).toContain("No daemons connected yet.");
  expect(markup).toContain("cc-remote pair");
});

test("HomeScreen shows 'Starting session...' while pending", () => {
  const markup = renderToStaticMarkup(
    <HomeScreen
      daemons={[{
        daemon_id: "d", hostname: "host-1", online: true, sessions: [],
      }]}
      pendingApprovalsCount={0}
      onSelectSession={() => {}}
      onStartSession={() => {}}
      onKillSession={() => {}}
      onOpenPermission={() => {}}
      pendingStartSessionByDaemon={{
        d: { id: "rs-1", kind: "start_session", daemon_id: "d",
             started_at: 0, status: "pending" },
      }}
      pendingKillByKey={{}}
    />,
  );
  expect(markup).toContain("Starting session");
  expect(markup).toMatch(/aria-label="Working directory[^"]*"[^>]*disabled/);
  expect(markup).toContain('data-testid="start-spinner"');
});

test("HomeScreen shows timeout copy when start_session timed_out", () => {
  const markup = renderToStaticMarkup(
    <HomeScreen
      daemons={[{
        daemon_id: "d", hostname: "host-1", online: true, sessions: [],
      }]}
      pendingApprovalsCount={0}
      onSelectSession={() => {}}
      onStartSession={() => {}}
      onKillSession={() => {}}
      onOpenPermission={() => {}}
      pendingStartSessionByDaemon={{
        d: { id: "rs-1", kind: "start_session", daemon_id: "d",
             started_at: 0, status: "timed_out" },
      }}
      pendingKillByKey={{}}
    />,
  );
  expect(markup).toContain("Start not confirmed");
});

test("HomeScreen shows 'Killing session...' while a kill is pending", () => {
  const sessionVm = {
    daemon_id: "d", session_id: "s1",
    name: "demo", model: "sonnet", cwd: "/x",
    state: "idle" as const, unread: 0, tasks: 0,
    activity: "now",
  };
  const markup = renderToStaticMarkup(
    <HomeScreen
      daemons={[{
        daemon_id: "d", hostname: "host-1", online: true,
        sessions: [sessionVm],
      }]}
      pendingApprovalsCount={0}
      onSelectSession={() => {}}
      onStartSession={() => {}}
      onKillSession={() => {}}
      onOpenPermission={() => {}}
      pendingStartSessionByDaemon={{}}
      pendingKillByKey={{
        "d::s1": { id: "kill-d-s1", kind: "kill_session",
                   daemon_id: "d", session_id: "s1",
                   started_at: 0, status: "pending" },
      }}
    />,
  );
  expect(markup).toContain("Killing session");
  expect(markup).toContain('data-testid="kill-pending-s1"');
});

test("HomeScreen renders inline start-session error for the affected daemon", () => {
  const markup = renderToStaticMarkup(
    <HomeScreen
      daemons={[onlineDaemon]}
      pendingApprovalsCount={0}
      onSelectSession={() => {}}
      onStartSession={() => {}}
      onKillSession={() => {}}
      onOpenPermission={() => {}}
      startSessionErrors={{
        d1: {
          type: "start_session_rejected",
          daemon_id: "d1",
          request_id: null,
          cwd: "/etc",
          reason: "cwd_not_allowed",
          message: "cwd /etc not in allowed_cwd_prefix",
        },
      }}
      onDismissStartSessionError={() => {}}
    />,
  );
  expect(markup).toContain('data-testid="start-session-error-d1"');
  expect(markup).toContain("cwd not allowed");
  expect(markup).toContain("/etc not in allowed_cwd_prefix");
});

test("HomeScreen shows 'Kill not confirmed. Try again.' on kill timeout", () => {
  const sessionVm = {
    daemon_id: "d", session_id: "s1",
    name: "demo", model: "sonnet", cwd: "/x",
    state: "idle" as const, unread: 0, tasks: 0,
    activity: "now",
  };
  const markup = renderToStaticMarkup(
    <HomeScreen
      daemons={[{
        daemon_id: "d", hostname: "host-1", online: true,
        sessions: [sessionVm],
      }]}
      pendingApprovalsCount={0}
      onSelectSession={() => {}}
      onStartSession={() => {}}
      onKillSession={() => {}}
      onOpenPermission={() => {}}
      pendingStartSessionByDaemon={{}}
      pendingKillByKey={{
        "d::s1": { id: "kill-d-s1", kind: "kill_session",
                   daemon_id: "d", session_id: "s1",
                   started_at: 0, status: "timed_out" },
      }}
    />,
  );
  expect(markup).toContain("Kill not confirmed");
  expect(markup).toContain('data-testid="kill-timeout-s1"');
});
