// packages/hub/tests/push-topics-payloads.test.ts
import { test, expect } from "bun:test";
import { getTopic } from "../src/push-topics.ts";

test("permission payload renders tool + args summary, tag uses request_id, requires interaction", () => {
  const topic = getTopic("permission");
  const p = topic.build_payload({
    daemon_id: "d-1", session_id: "sess-1", request_id: "r-99",
    tool: "Bash", args_summary: "rm -rf /tmp/x",
  });
  expect(p.kind).toBe("permission");
  expect(p.title).toBe("cc-remote");
  expect(p.body).toContain("d-1");
  expect(p.body).toContain("Bash");
  expect(p.body).toContain("rm -rf /tmp/x");
  expect(p.require_interaction).toBe(true);
  expect(topic.build_tag(p)).toBe("permission:r-99");
});

test("idle payload renders daemon + session, tag scoped to (daemon, session)", () => {
  const topic = getTopic("idle");
  const p = topic.build_payload({ daemon_id: "d-1", session_id: "sess-1" });
  expect(p.kind).toBe("idle");
  expect(p.body).toContain("idle");
  expect(topic.build_tag(p)).toBe("idle:d-1:sess-1");
});
