import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PwaPermissionRequest } from "@cc-remote/proto";
import type { PendingCommand } from "../src/hooks/pendingCommands";
import { InlinePermissionCard } from "../src/screens/primitives/InlinePermissionCard";

const baseRequest: PwaPermissionRequest = {
  type: "permission_request",
  daemon_id: "d1",
  session_id: "s1",
  request_id: "req-abc12345",
  tool: "Bash",
  args_summary: "rm -rf /tmp/cc-remote-demo/scratch.txt",
  expires_at: 0,
};

test("InlinePermissionCard renders tool, command, and request_id slice", () => {
  const markup = renderToStaticMarkup(
    <InlinePermissionCard request={baseRequest} onDecide={() => {}} />,
  );
  expect(markup).toContain('data-testid="inline-permission-card"');
  expect(markup).toMatch(/<span[^>]*>Permission<\/span>/);
  expect(markup).toContain("Bash");
  expect(markup).toContain("rm -rf /tmp/cc-remote-demo/scratch.txt");
  // request_id slice 0..8 — first 8 chars displayed
  expect(markup).toContain("req-abc1");
});

test("InlinePermissionCard exposes Allow and Deny buttons", () => {
  const markup = renderToStaticMarkup(
    <InlinePermissionCard request={baseRequest} onDecide={() => {}} />,
  );
  expect(markup).toMatch(/<button[^>]*>\s*Allow once\s*<\/button>/);
  expect(markup).toMatch(/<button[^>]*>\s*Deny\s*<\/button>/);
});

test("InlinePermissionCard disables both buttons while reply is pending", () => {
  const pending: PendingCommand = {
    id: "req-abc12345",
    kind: "permission_reply",
    daemon_id: "d1",
    session_id: "s1",
    started_at: 0,
    status: "pending",
    label: "allow",
  };
  const markup = renderToStaticMarkup(
    <InlinePermissionCard request={baseRequest} pendingReply={pending} onDecide={() => {}} />,
  );
  expect(markup).toMatch(/<button[^>]*disabled[^>]*>\s*Allow once/);
  expect(markup).toMatch(/<button[^>]*disabled[^>]*>\s*Deny/);
  expect(markup).toContain("Sending decision");
});

test("InlinePermissionCard shows timeout copy when reply timed_out", () => {
  const timedOut: PendingCommand = {
    id: "req-abc12345",
    kind: "permission_reply",
    daemon_id: "d1",
    session_id: "s1",
    started_at: 0,
    status: "timed_out",
    label: "allow",
  };
  const markup = renderToStaticMarkup(
    <InlinePermissionCard request={baseRequest} pendingReply={timedOut} onDecide={() => {}} />,
  );
  expect(markup).toContain("Decision not confirmed");
});

test("InlinePermissionCard renders verbatim args even when very long", () => {
  const longArgs = "pnpm --filter @cc-remote/hub run test packages/hub/tests/push-topics-registry.test.ts --reporter=verbose --bail=1";
  const markup = renderToStaticMarkup(
    <InlinePermissionCard
      request={{ ...baseRequest, args_summary: longArgs }}
      onDecide={() => {}}
    />,
  );
  expect(markup).toContain(longArgs);
});
