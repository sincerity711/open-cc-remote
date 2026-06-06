import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  PwaPermissionRequest,
  PwaPermissionResolved,
} from "@cc-remote/proto";
import { ResolvedPermissionCard } from "../src/screens/timeline/ResolvedPermissionCard";

const baseRequest: PwaPermissionRequest = {
  type: "permission_request",
  daemon_id: "d1",
  session_id: "s1",
  request_id: "req-abc12345",
  tool: "Bash",
  args_summary: "rm -rf /tmp/cc-remote-demo/scratch.txt",
  expires_at: 0,
};

const baseResolved = (
  decision: PwaPermissionResolved["decision"],
  request_id = "req-abc12345",
): PwaPermissionResolved => ({
  type: "permission_resolved",
  daemon_id: "d1",
  session_id: "s1",
  request_id,
  decision,
  decided_via: "pwa",
});

function visibleText(markup: string): string {
  return markup.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

test("with-request allow → ALLOWED pill, success tone, tokenized command visible", () => {
  const markup = renderToStaticMarkup(
    <ResolvedPermissionCard resolved={baseResolved("allow")} request={baseRequest} />,
  );
  expect(markup).toContain('data-testid="resolved-permission-card"');
  // Pill text
  const text = visibleText(markup);
  expect(text).toContain("Allowed");
  expect(text).toContain("Bash");
  expect(text).toContain("rm -rf /tmp/cc-remote-demo/scratch.txt");
  expect(text).toContain("you allowed this");
  // Tone — success-subtle background hook from the article element.
  expect(markup).toContain("bg-success-subtle");
  // request id slice
  expect(text).toContain("req-abc1");
});

test("with-request deny → DENIED pill, danger tone", () => {
  const markup = renderToStaticMarkup(
    <ResolvedPermissionCard resolved={baseResolved("deny")} request={baseRequest} />,
  );
  const text = visibleText(markup);
  expect(text).toContain("Denied");
  expect(text).toContain("you denied this");
  expect(markup).toContain("bg-danger-subtle");
});

test("no-request path → '(command not in history)' placeholder", () => {
  const markup = renderToStaticMarkup(
    <ResolvedPermissionCard resolved={baseResolved("allow", "req-xyz")} request={null} />,
  );
  expect(markup).toContain('data-testid="resolved-permission-no-request"');
  const text = visibleText(markup);
  expect(text).toContain("(command not in history)");
  // Falls back to generic title since we don't know the tool.
  expect(text).toContain("Permission");
});

test("expired decision → EXPIRED pill, muted tone", () => {
  const markup = renderToStaticMarkup(
    <ResolvedPermissionCard resolved={baseResolved("expired")} request={baseRequest} />,
  );
  const text = visibleText(markup);
  expect(text).toContain("Expired");
  expect(text).toContain("expired without a decision");
  // Neither success nor danger background.
  expect(markup).not.toContain("bg-success-subtle");
  expect(markup).not.toContain("bg-danger-subtle");
});

test("decided_via != 'pwa' surfaces via footer", () => {
  const markup = renderToStaticMarkup(
    <ResolvedPermissionCard
      resolved={{ ...baseResolved("allow"), decided_via: "tui" }}
      request={baseRequest}
    />,
  );
  expect(visibleText(markup)).toContain("decided via tui");
});

test("decided_via 'pwa' does NOT show 'decided via' footer (default)", () => {
  const markup = renderToStaticMarkup(
    <ResolvedPermissionCard resolved={baseResolved("allow")} request={baseRequest} />,
  );
  expect(visibleText(markup)).not.toContain("decided via");
});
