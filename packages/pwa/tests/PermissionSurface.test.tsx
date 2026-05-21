import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PwaPermissionRequest } from "@cc-remote/proto";
import { PermissionSurface } from "../src/screens/PermissionSurface";

const request: PwaPermissionRequest = {
  type: "permission_request",
  daemon_id: "d1",
  session_id: "s1",
  request_id: "r1",
  tool: "Bash",
  args_summary: "rm -rf node_modules",
  expires_at: 0,
};

test.each(["mobile", "tablet", "desktop"] as const)(
  "PermissionSurface renders on %s with request details",
  (device) => {
    const markup = renderToStaticMarkup(
      <PermissionSurface
        request={request}
        daemonHostname="mbp.local"
        queueIndex={1}
        queueSize={3}
        device={device}
        onAllow={() => {}}
        onDeny={() => {}}
        onClose={() => {}}
      />,
    );
    expect(markup).toContain("Claude requests permission");
    expect(markup).toContain("Bash");
    expect(markup).toContain("rm -rf node_modules");
    expect(markup).toContain("1 of 3 pending");
    expect(markup).toContain('data-testid="permission-surface"');
  },
);

test("PermissionSurface omits queue line when only one request", () => {
  const markup = renderToStaticMarkup(
    <PermissionSurface
      request={request}
      daemonHostname="mbp.local"
      queueIndex={1}
      queueSize={1}
      device="desktop"
      onAllow={() => {}}
      onDeny={() => {}}
      onClose={() => {}}
    />,
  );
  expect(markup).not.toContain("of 1 pending");
  expect(markup).not.toContain('data-testid="permission-queue"');
});
