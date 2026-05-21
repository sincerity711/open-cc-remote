import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionView } from "../src/screens/SessionView";
import type { TimelineEvent } from "../src/screens/timeline/types";

const items: TimelineEvent[] = [
  {
    id: "chat:m1",
    kind: "user",
    title: "alice@example.com",
    body: "hello claude",
    time: "10:24 AM",
  },
  {
    id: "chat:m2",
    kind: "assistant",
    title: "Claude",
    body: "hello back",
    time: "10:24 AM",
  },
  {
    id: "event:1",
    kind: "raw",
    title: "session_start",
    json: '{"type":"session_start"}',
  },
];

test("SessionView renders header, timeline items, and composer", () => {
  const markup = renderToStaticMarkup(
    <SessionView
      header={{ name: "session-1", model: "sonnet", cwd: "/home/alice/proj", online: true }}
      items={items}
      composerBlocked={false}
      onLoadEarlier={() => {}}
      onSendChat={() => {}}
      onOpenPermission={() => {}}
      onBack={() => {}}
    />,
  );

  expect(markup).toContain("session-1");
  expect(markup).toContain("/home/alice/proj");
  expect(markup).toContain("Online");
  expect(markup).toContain("hello claude");
  expect(markup).toContain("hello back");
  expect(markup).toContain("session_start");
  expect(markup).toContain('data-testid="chat-input"');
  expect(markup).toContain('data-testid="timeline"');
  expect(markup).toContain("Message Claude");
});

test("SessionView shows the permission warning strip when blocked", () => {
  const markup = renderToStaticMarkup(
    <SessionView
      header={{ name: "session-1", model: null, cwd: "/x", online: true }}
      items={[]}
      composerBlocked={true}
      pendingPermissionInThisSession={{
        type: "permission_request",
        daemon_id: "d",
        session_id: "s",
        request_id: "req-1",
        tool: "Bash",
        args_summary: "rm -rf /",
        expires_at: 1_700_000_000,
      }}
      onLoadEarlier={() => {}}
      onSendChat={() => {}}
      onOpenPermission={() => {}}
      onBack={() => {}}
    />,
  );

  expect(markup).toContain("Permission required before Claude can continue.");
  expect(markup).toContain("Review");
  expect(markup).toContain("Waiting for permission");
});

test("SessionView reports offline state in header and disables composer placeholder", () => {
  const markup = renderToStaticMarkup(
    <SessionView
      header={{ name: "session-1", model: null, cwd: "/x", online: false }}
      items={[]}
      composerBlocked={false}
      onLoadEarlier={() => {}}
      onSendChat={() => {}}
      onOpenPermission={() => {}}
      onBack={() => {}}
    />,
  );

  expect(markup).toContain("Offline");
  expect(markup).toContain("session offline");
});

test("SessionView shows the connection-lost banner when not connected", () => {
  const markup = renderToStaticMarkup(
    <SessionView
      header={{ name: "session-1", model: null, cwd: "/x", online: true }}
      items={[]}
      composerBlocked={false}
      connected={false}
      onLoadEarlier={() => {}}
      onSendChat={() => {}}
      onOpenPermission={() => {}}
      onBack={() => {}}
    />,
  );

  expect(markup).toContain("Connection lost");
  expect(markup).toContain('data-testid="connection-banner"');
});

test("SessionView omits the connection-lost banner when connected", () => {
  const markup = renderToStaticMarkup(
    <SessionView
      header={{ name: "session-1", model: null, cwd: "/x", online: true }}
      items={[]}
      composerBlocked={false}
      connected={true}
      onLoadEarlier={() => {}}
      onSendChat={() => {}}
      onOpenPermission={() => {}}
      onBack={() => {}}
    />,
  );

  expect(markup).not.toContain("connection-banner");
});

test("SessionView renders the idle synthetic-last item when idle is true", () => {
  const markup = renderToStaticMarkup(
    <SessionView
      header={{ name: "session-1", model: "sonnet", cwd: "/x", online: true }}
      items={items}
      composerBlocked={false}
      idle={true}
      onLoadEarlier={() => {}}
      onSendChat={() => {}}
      onOpenPermission={() => {}}
      onBack={() => {}}
    />,
  );

  expect(markup).toContain("How would you like to proceed");
});
