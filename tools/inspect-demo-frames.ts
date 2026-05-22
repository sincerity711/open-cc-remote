#!/usr/bin/env bun
// Inspect what frames the demo hub broadcasts to a PWA.
// Run while interacting in tmux: `bun tools/inspect-demo-frames.ts`
//
// Requires the hub to be running locally. Bearer is minted via the admin CLI:
//   bun packages/hub/src/admin.ts mint-bearer <owner_sub>
// The hub must be pointing at its SQLite DB (HUB_DB_PATH, default ./hub.sqlite).
// Set HUB_OWNER_SUB to override the default owner subject used for minting.

import { spawnSync } from "node:child_process";
import { join } from "node:path";

const HUB = "http://localhost:17745";
const REPO_ROOT = join(import.meta.dir, "..");
const OWNER_SUB = process.env.HUB_OWNER_SUB ?? "local-admin";

async function main() {
  // 1. Mint a bearer directly via the hub admin CLI (no IAS required).
  const result = spawnSync(
    "bun",
    ["packages/hub/src/admin.ts", "mint-bearer", OWNER_SUB, "inspect-demo-frames"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`admin mint-bearer failed:\n${result.stderr}`);
  }
  const bearer = result.stdout.trim();
  if (!bearer) throw new Error("admin mint-bearer returned empty bearer");

  // 2. Open the WS.
  const ws = new WebSocket(`ws://localhost:17745/ws/pwa?bearer=${encodeURIComponent(bearer)}`);
  ws.onopen = () => ws.send(JSON.stringify({ type: "subscribe" }));
  ws.onmessage = (ev) => {
    try {
      const f = JSON.parse(ev.data as string);
      if (f.type === "event") {
        const p = f.payload ?? {};
        const blocks = Array.isArray(p?.message?.content)
          ? p.message.content.map((b: { type?: string }) => b?.type ?? "?").join(",")
          : "—";
        console.log(`event jsonl_offset=${f.jsonl_offset} payload.type=${p.type} blocks=[${blocks}]`);
      } else {
        console.log(`${f.type}`);
      }
    } catch {}
  };
  ws.onerror = (e) => console.error("ws error", e);

  // Stay alive 60s.
  await new Promise((r) => setTimeout(r, 60_000));
  ws.close();
}

main().catch(console.error);
