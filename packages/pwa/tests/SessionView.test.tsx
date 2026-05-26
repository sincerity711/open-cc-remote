import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionView } from "../src/screens/SessionView";
import type { RenderItem } from "../src/screens/timeline/types";
import { EventType } from "@cc-remote/proto";

const items: RenderItem[] = [
  {
    tag: "agui",
    id: "agui:m1",
    ts: 1_700_000_000_000,
    event: {
      type: EventType.TEXT_MESSAGE_CHUNK,
      messageId: "m1",
      role: "user",
      delta: "hello claude",
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
  expect(markup).toContain("Reconnect before sending");
});

test("SessionView shows 'Sending message...' row while a chat send is pending", () => {
  const markup = renderToStaticMarkup(
    <SessionView
      header={{ name: "s", model: null, cwd: "/x", online: true }}
      items={[]}
      composerBlocked={false}
      pendingChatSend={{
        id: "cm-1", kind: "chat_send",
        daemon_id: "d", session_id: "s",
        started_at: 0, status: "pending",
      }}
      onLoadEarlier={() => {}}
      onSendChat={() => {}}
      onOpenPermission={() => {}}
      onBack={() => {}}
      onDismissPendingCommand={() => {}}
    />,
  );
  expect(markup).toContain("Sending message");
  expect(markup).toMatch(/data-testid="chat-input"[^>]*disabled/);
});

test("SessionView shows timeout message when chat send timed out", () => {
  const markup = renderToStaticMarkup(
    <SessionView
      header={{ name: "s", model: null, cwd: "/x", online: true }}
      items={[]}
      composerBlocked={false}
      pendingChatSend={{
        id: "cm-1", kind: "chat_send",
        daemon_id: "d", session_id: "s",
        started_at: 0, status: "timed_out",
      }}
      onLoadEarlier={() => {}}
      onSendChat={() => {}}
      onOpenPermission={() => {}}
      onBack={() => {}}
      onDismissPendingCommand={() => {}}
    />,
  );
  expect(markup).toContain("Message not confirmed");
});

test("SessionView no longer renders queued-count banner", () => {
  const markup = renderToStaticMarkup(
    <SessionView
      header={{ name: "s", model: null, cwd: "/x", online: true }}
      items={[]}
      composerBlocked={false}
      connected={false}
      onLoadEarlier={() => {}}
      onSendChat={() => {}}
      onOpenPermission={() => {}}
      onBack={() => {}}
      onDismissPendingCommand={() => {}}
    />,
  );
  expect(markup).not.toContain("queued-count");
  expect(markup).toContain("Reconnect before sending");
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

test("SessionView shows failed-with-error message", () => {
  const markup = renderToStaticMarkup(
    <SessionView
      header={{ name: "s", model: null, cwd: "/x", online: true }}
      items={[]}
      composerBlocked={false}
      pendingChatSend={{
        id: "cm-1", kind: "chat_send",
        daemon_id: "d", session_id: "s",
        started_at: 0, status: "failed",
        error: "daemon_offline",
      }}
      onLoadEarlier={() => {}}
      onSendChat={() => {}}
      onOpenPermission={() => {}}
      onBack={() => {}}
      onDismissPendingCommand={() => {}}
    />,
  );
  expect(markup).toContain("Message not confirmed");
  expect(markup).toContain("daemon_offline");
  expect(markup).toContain('data-testid="chat-send-failure"');
});

test("SessionView disables composer when disconnected", () => {
  const markup = renderToStaticMarkup(
    <SessionView
      header={{ name: "s", model: null, cwd: "/x", online: true }}
      items={[]}
      composerBlocked={false}
      connected={false}
      onLoadEarlier={() => {}}
      onSendChat={() => {}}
      onOpenPermission={() => {}}
      onBack={() => {}}
      onDismissPendingCommand={() => {}}
    />,
  );
  expect(markup).toMatch(/data-testid="chat-input"[^>]*disabled/);
});
