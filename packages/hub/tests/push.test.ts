import { test, expect } from "bun:test";
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
