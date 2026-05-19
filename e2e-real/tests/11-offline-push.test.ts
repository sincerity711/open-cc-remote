// Scenario 11 — daemon disconnects → after HUB_OFFLINE_PUSH_DELAY_MS the hub
// invokes the push helper. The hub is started with HUB_TEST_MODE=1 so the
// helper writes to /data/push-trace.log; we read it via `docker compose exec`.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { upCompose, downCompose, execHubCmd } from "../helpers/compose.ts";
import { loginAndConnect } from "../helpers/pwa-client.ts";
import { pairAndStartDaemon } from "../helpers/scenario.ts";

beforeAll(async () => { await upCompose(); }, 300_000);
afterAll(async () => { await downCompose(); }, 60_000);

test("daemon offline → push helper invoked (file-log stub)", async () => {
  const daemon_id = `offline-${Date.now()}`;

  const handle = await pairAndStartDaemon({
    daemon_id,
    hub_url: "ws://localhost:7745",
    hub_http: "http://localhost:7745",
  });

  const pwa = await loginAndConnect({
    hub_http: "http://localhost:7745",
    hub_ws: "ws://localhost:7745",
  });

  try {
    // Subscribe a fake browser push endpoint.
    const subRes = await fetch("http://localhost:7745/push/subscribe", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${pwa.bearer}`,
      },
      body: JSON.stringify({
        endpoint: "https://fake-push.example.com/abc",
        keys: { p256dh: "BHbVwfOA-jhJsBmhXbY3rFSltNAfMUE7CzKpTwPqv3FtFPUBFOnlz4hL_rNqgxgpvU3DmM6BLWxRMW9hbn_a4BU", auth: "lT7e_CSqhT05_x5G7oM_NjEr_g2A55_2_y1l4Y7H6yc" },
      }),
    });
    expect(subRes.status).toBe(204);

    // Enable offline push preference.
    const prefRes = await fetch("http://localhost:7745/push/preferences", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${pwa.bearer}`,
      },
      body: JSON.stringify({ permission: true, offline: true }),
    });
    expect(prefRes.status).toBe(204);

    // Wait for daemon to be visible to PWA (snapshot or daemon_online).
    await pwa.waitFor((f) => {
      if (f.type === "daemon_online" && f.daemon_id === daemon_id) return f;
      if (f.type === "snapshot") {
        for (const d of f.daemons) {
          if (d.daemon_id === daemon_id) return f;
        }
      }
      return false;
    }, 15_000, "daemon visible (online or in snapshot)");

    // Stop the daemon to trigger offline path.
    await handle.stop();

    // Poll the trace log up to 5s.
    const start = Date.now();
    let foundLine: { payload: { kind?: string; daemon_id?: string } } | undefined;
    while (Date.now() - start < 5_000 && !foundLine) {
      let raw = "";
      try {
        raw = execHubCmd(["sh", "-c", "cat /data/push-trace.log 2>/dev/null || true"]);
      } catch { /* file may not exist yet */ }
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as { payload: { kind?: string; daemon_id?: string } };
          if (parsed.payload && (parsed.payload.kind === "offline" || parsed.payload.kind === "daemon_offline") &&
              parsed.payload.daemon_id === daemon_id) {
            foundLine = parsed;
            break;
          }
        } catch { /* skip bad line */ }
      }
      if (!foundLine) await new Promise((r) => setTimeout(r, 250));
    }
    expect(foundLine).toBeDefined();
  } finally {
    pwa.close();
    // handle.stop already called, but cleanup tmpdir.
    if ((handle as any).cleanup) await (handle as any).cleanup();
  }
}, 60_000);
