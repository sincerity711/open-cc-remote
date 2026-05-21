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
