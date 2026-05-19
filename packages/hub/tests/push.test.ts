import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPushHelper } from "../src/push.ts";

test("createPushHelper returns no-op when vapid is undefined", async () => {
  const h = createPushHelper(undefined);
  // Should not throw and should not actually send.
  await h.sendTo(
    [{ device_id: "d1", endpoint: "https://x", p256dh: "p", auth: "a", preferences: { permission: true } }],
    { kind: "test" },
  );
  // No-op — nothing to assert beyond "did not throw".
  expect(true).toBe(true);
});

test("createPushHelper returns active helper when vapid is provided", () => {
  // Dummy VAPID keys are accepted by setVapidDetails as long as they're well-formed
  // base64url. We just verify the helper exists and has sendTo.
  const h = createPushHelper({
    subject: "mailto:test@example.com",
    public_key: "BHbVwfOA-jhJsBmhXbY3rFSltNAfMUE7CzKpTwPqv3FtFPUBFOnlz4hL_rNqgxgpvU3DmM6BLWxRMW9hbn_a4BU",
    private_key: "lT7e_CSqhT05_x5G7oM_NjEr_g2A55_2_y1l4Y7H6yc",
  });
  expect(typeof h.sendTo).toBe("function");
});

test("createPushHelper returns file-log stub when HUB_TEST_MODE=1", async () => {
  const dir = mkdtempSync(join(tmpdir(), "push-trace-"));
  const path = join(dir, "push-trace.log");
  const prevTestMode = process.env.HUB_TEST_MODE;
  const prevPath = process.env.HUB_PUSH_TRACE_PATH;
  process.env.HUB_TEST_MODE = "1";
  process.env.HUB_PUSH_TRACE_PATH = path;
  try {
    const h = createPushHelper(undefined);
    await h.sendTo(
      [{ device_id: "d1", endpoint: "https://x", p256dh: "p", auth: "a", preferences: { permission: true } }],
      { kind: "permission", request_id: "abcde" },
    );
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.subs).toEqual(["d1"]);
    expect(parsed.payload.kind).toBe("permission");
    expect(parsed.payload.request_id).toBe("abcde");
    expect(typeof parsed.ts).toBe("number");
  } finally {
    if (prevTestMode === undefined) delete process.env.HUB_TEST_MODE; else process.env.HUB_TEST_MODE = prevTestMode;
    if (prevPath === undefined) delete process.env.HUB_PUSH_TRACE_PATH; else process.env.HUB_PUSH_TRACE_PATH = prevPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

