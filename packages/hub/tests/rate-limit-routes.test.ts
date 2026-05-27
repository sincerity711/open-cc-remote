import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { makeServer } from "../src/routes.ts";

function setupServer(opts: { pair_per_min?: number; pair_refresh_per_min?: number; ws_daemon_per_min?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ccr-rl-"));
  const db = openDb(join(dir, "h.sqlite"));
  const { fetch, websocket } = makeServer({
    db, jwt_secret: "s", disable_auth: false, pwa_url: "/",
    rate_limit: {
      pair_per_min: opts.pair_per_min ?? 10,
      pair_refresh_per_min: opts.pair_refresh_per_min ?? 30,
      ws_daemon_per_min: opts.ws_daemon_per_min ?? 30,
    },
  });
  const server = Bun.serve({ port: 0, fetch, websocket });
  return {
    server, db,
    url: (path: string) => `http://localhost:${server.port}${path}`,
    cleanup: () => { server.stop(true); db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("/pair rate-limits after configured budget", async () => {
  const s = setupServer({ pair_per_min: 10 });
  try {
    let rejected = 0;
    for (let i = 0; i < 11; i++) {
      const res = await fetch(s.url("/pair"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      // Drain body so the connection is reusable.
      await res.text();
      if (res.status === 429) rejected++;
    }
    expect(rejected).toBe(1);
  } finally { s.cleanup(); }
});

test("/pair/refresh rate-limits before reading DPoP", async () => {
  const s = setupServer({ pair_refresh_per_min: 3 });
  try {
    let rejected = 0;
    for (let i = 0; i < 4; i++) {
      const res = await fetch(s.url("/pair/refresh"), { method: "POST" });
      await res.text();
      if (res.status === 429) rejected++;
    }
    expect(rejected).toBe(1);
  } finally { s.cleanup(); }
});
