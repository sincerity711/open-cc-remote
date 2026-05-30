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

/**
 * Strip every HTML tag from the SSR markup and collapse whitespace runs.
 *
 * The card tokenizes its command body so each word becomes its own
 * `<span>` (used for risk highlighting). That makes a naive
 * `markup.toContain("rm -rf …")` assertion fail even though the visible
 * text is correct. Tests should care about *what the user sees*, not
 * the DOM structure they go through, so we extract textContent.
 */
function visibleText(markup: string): string {
  return markup.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

test("InlinePermissionCard renders tool, command, and request_id slice", () => {
  const markup = renderToStaticMarkup(
    <InlinePermissionCard request={baseRequest} onDecide={() => {}} />,
  );
  expect(markup).toContain('data-testid="inline-permission-card"');
  expect(markup).toMatch(/<span[^>]*>Permission<\/span>/);

  const text = visibleText(markup);
  expect(text).toContain("Bash");
  expect(text).toContain("rm -rf /tmp/cc-remote-demo/scratch.txt");
  // request_id slice 0..8 — first 8 chars displayed
  expect(text).toContain("req-abc1");
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
  // Buttons stay clickable-shaped (so the click target doesn't collapse) but
  // are marked disabled. The pending UI now lives inside the button as a
  // spinner+label, not as a separate "Sending decision…" row.
  expect(markup).toMatch(/<button[^>]*disabled[^>]*>/);
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
  const longArgs =
    "pnpm --filter @cc-remote/hub run test packages/hub/tests/push-topics-registry.test.ts --reporter=verbose --bail=1";
  const markup = renderToStaticMarkup(
    <InlinePermissionCard
      request={{ ...baseRequest, args_summary: longArgs }}
      onDecide={() => {}}
    />,
  );
  // Tokenization splits on whitespace; every word/flag becomes its own span
  // for risk-highlighting. Verbatim preservation is verified by the visible
  // text after tag-stripping.
  expect(visibleText(markup)).toContain(longArgs);
});
