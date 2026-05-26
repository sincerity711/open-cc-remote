// Scenario 21 — push topics end-to-end against the real hub container.
//
// Verifies the full pipeline: HTTP API to write topic_subscriptions, daemon
// disconnect triggers offline-topic dispatch via dispatchTopic, push trace
// records the expected payload (kind, tag).
// Per-daemon override + DND filtering are covered by unit tests
// (push-dispatch.test.ts, dnd.test.ts).

import { test, expect } from "@playwright/test";
import { upCompose, downCompose } from "../helpers/compose.ts";
import { pairAndStartDaemon } from "../helpers/scenario.ts";
import { loginAndConnect } from "../helpers/pwa-client.ts";
import { clearPushTrace, waitForPushKind } from "../helpers/push-trace.ts";

const HUB_HTTP = "http://localhost:7745";
const HUB_WS = "ws://localhost:7745";

test.beforeAll(async () => { await upCompose(); });
test.afterAll(async () => { await downCompose(); });

async function api(bearer: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${HUB_HTTP}${path}`, {
    ...init,
    headers: { ...init.headers, authorization: `Bearer ${bearer}` },
  });
  if (!res.ok && res.status !== 204) {
    throw new Error(`${init.method ?? "GET"} ${path} → ${res.status} ${await res.text()}`);
  }
  return res.status === 204 ? null : await res.json();
}

test("push topics: subscribe → enable offline → daemon disconnect → trace records dispatch", async () => {
  test.setTimeout(120_000);

  const daemon_id = `pt-${Date.now()}`;
  const handle = await pairAndStartDaemon({
    daemon_id, hub_url: HUB_WS, hub_http: HUB_HTTP,
  });

  const pwa = await loginAndConnect({ hub_http: HUB_HTTP, hub_ws: HUB_WS });

  try {
    const subRes = await fetch(`${HUB_HTTP}/push/subscribe`, {
      method: "POST",
      headers: { authorization: `Bearer ${pwa.bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ endpoint: `https://fake/${daemon_id}`, keys: { p256dh: "p", auth: "a" } }),
    });
    expect(subRes.status).toBe(204);

    const topicsBody = await api(pwa.bearer, "/push/topics") as { topics: Array<{ id: string }> };
    expect(topicsBody.topics.map((t) => t.id).sort()).toEqual(["completed", "idle", "offline", "permission"]);

    await api(pwa.bearer, "/push/topics/subscriptions", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic_id: "offline", daemon_id: null, enabled: true }),
    });

    await clearPushTrace();
    await handle.cleanup();
    const entry = await waitForPushKind("offline", 5_000);
    expect(entry).not.toBeNull();
    expect(entry!.payload.tag).toBe(`offline:${daemon_id}`);
    expect(entry!.payload.kind).toBe("offline");
  } finally {
    pwa.close();
    try { await handle.cleanup(); } catch { /* may have been cleaned */ }
  }
});
