import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionView } from "../src/screens/SessionView";
import type { RenderItem } from "../src/screens/timeline/types";
import { EventType } from "@cc-remote/proto";

const items: RenderItem[] = [
  {
    tag: "chat",
    id: "chat:m1",
    ts: 1_700_000_000_000,
    chat: {
      type: "chat",
      daemon_id: "d",
      session_id: "s",
      message_id: "m1",
      from: "pwa",
      user: "alice@example.com",
      content: "hello claude",
      reply_to: null,
      ts: 1_700_000_000_000,
    },
  },
  {
    tag: "agui",
    id: "agui:m2",
    ts: 1_700_000_001_000,
    event: {
      type: EventType.TEXT_MESSAGE_CHUNK,
      messageId: "m2",
      role: "assistant",
      delta: "hello back",
    },
  },
  {
    tag: "agui",
    id: "agui:raw1",
    ts: 1_700_000_002_000,
    event: {
      type: EventType.RAW,
      event: { type: "session_start" },
    },
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

test("SessionView no longer renders the IdleWaitingCard — status chip in the header is the source of truth for idle", () => {
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

  expect(markup).not.toContain("How would you like to proceed");
  expect(markup).not.toContain("Waiting for input");
});
