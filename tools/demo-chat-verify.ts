#!/usr/bin/env bun
// Diagnostic: simulate PWA login + chat_send + watch broadcasts.
// Used to isolate whether a "Send button does nothing" symptom is a PWA UI
// bug or a backend (hub/daemon/plugin) bug. If THIS script succeeds end-to-
// end, the backend is fine and the bug is in PWA UI wiring.
//
// Usage:
//   bun tools/demo-chat-verify.ts <daemon_id> <session_id> "<content>"
//
// Defaults to daemon_id=demo-1 and grabs the first session from the snapshot.

import { setTimeout as delay } from "node:timers/promises";

const HUB_HTTP = "http://localhost:17745";
const HUB_WS = "ws://localhost:17745";

const argv = process.argv.slice(2);
const wantedDaemon = argv[0] ?? "demo-1";
const wantedSession = argv[1];           // optional; auto-pick if absent
const content = argv[2] ?? "ping from CLI verifier";

console.log(`[verify] target daemon=${wantedDaemon} content=${JSON.stringify(content)}`);

// ─── 1. Login chain (manual redirect follow, mimics what PWA does) ────────────
console.log("[verify] step 1: login chain");
const r1 = await fetch(`${HUB_HTTP}/auth/login`, { redirect: "manual" });
if (r1.status !== 302) throw new Error(`/auth/login expected 302, got ${r1.status}`);
const authUrl = r1.headers.get("location");
if (!authUrl) throw new Error("/auth/login missing Location");
console.log(`[verify]   → authorize: ${authUrl}`);

const r2 = await fetch(authUrl, { redirect: "manual" });
if (r2.status !== 302) throw new Error(`authorize expected 302, got ${r2.status}: ${await r2.text()}`);
const cbUrl = r2.headers.get("location");
if (!cbUrl) throw new Error("authorize missing Location");
console.log(`[verify]   → callback: ${cbUrl}`);

const r3 = await fetch(cbUrl, { redirect: "manual" });
if (r3.status !== 302) throw new Error(`callback expected 302, got ${r3.status}: ${await r3.text()}`);
const finalLoc = r3.headers.get("location") ?? "";
const m = finalLoc.match(/#bearer=([^&]+)/);
if (!m || !m[1]) throw new Error(`no #bearer in: ${finalLoc}`);
const bearer = decodeURIComponent(m[1]);
console.log(`[verify]   bearer obtained: ${bearer.slice(0, 20)}…`);

// ─── 2. WS connect + subscribe ────────────────────────────────────────────────
console.log("[verify] step 2: WS connect + subscribe");
const ws = new WebSocket(`${HUB_WS}/ws/pwa?bearer=${encodeURIComponent(bearer)}`);
const inbox: any[] = [];
ws.addEventListener("message", (ev) => {
  try {
    const f = JSON.parse(typeof ev.data === "string" ? ev.data : "");
    inbox.push(f);
    console.log(`[verify]   ← hub frame: type=${f.type}${f.daemon_id ? ` daemon=${f.daemon_id}` : ""}${f.session_id ? ` session=${f.session_id}` : ""}${f.from ? ` from=${f.from}` : ""}${f.content ? ` content=${JSON.stringify(f.content).slice(0, 60)}` : ""}`);
  } catch {}
});
await new Promise<void>((res, rej) => {
  ws.addEventListener("open", () => res(), { once: true });
  ws.addEventListener("error", () => rej(new Error("ws upgrade failed")), { once: true });
});
ws.send(JSON.stringify({ type: "subscribe" }));
console.log("[verify]   subscribed");

// ─── 3. Wait for snapshot, find target session ────────────────────────────────
console.log("[verify] step 3: wait for snapshot/session_open");
const snapshotDeadline = Date.now() + 5000;
let session_id = wantedSession;
while (Date.now() < snapshotDeadline) {
  const snap = inbox.find((f) => f.type === "snapshot");
  if (snap) {
    const d = snap.daemons.find((d: any) => d.daemon_id === wantedDaemon);
    if (!d) {
      console.error(`[verify] daemon ${wantedDaemon} not in snapshot. Daemons present: ${snap.daemons.map((x: any) => x.daemon_id).join(", ") || "(none)"}`);
      process.exit(2);
    }
    if (!d.online) {
      console.error(`[verify] daemon ${wantedDaemon} is offline`);
      process.exit(2);
    }
    if (!session_id) {
      const s = d.sessions[0];
      if (!s) {
        console.error(`[verify] daemon ${wantedDaemon} has no sessions`);
        process.exit(2);
      }
      session_id = s.session_id;
      console.log(`[verify]   auto-selected session_id=${session_id}`);
    }
    break;
  }
  await delay(50);
}
if (!session_id) {
  console.error(`[verify] no snapshot received within 5s; aborting`);
  process.exit(2);
}

// ─── 4. Send chat_send ────────────────────────────────────────────────────────
console.log(`[verify] step 4: sending chat_send`);
const sendFrame = { type: "chat_send", daemon_id: wantedDaemon, session_id, content };
ws.send(JSON.stringify(sendFrame));
console.log(`[verify]   → ${JSON.stringify(sendFrame)}`);

// ─── 5. Watch for echo + claude reply (or chat_error) ─────────────────────────
console.log(`[verify] step 5: watching for echo (from:"pwa") and reply (from:"claude") for 60s`);
const echoDeadline = Date.now() + 60_000;
let sawEcho = false;
let sawClaudeReply = false;
let sawError = false;
while (Date.now() < echoDeadline) {
  for (const f of inbox) {
    if (!sawEcho && f.type === "chat" && f.from === "pwa" && f.session_id === session_id && f.content === content) {
      console.log(`[verify]   ✓ echo received (PWA→Hub→PWA broadcast works)`);
      sawEcho = true;
    }
    if (!sawClaudeReply && f.type === "chat" && f.from === "claude" && f.session_id === session_id) {
      console.log(`[verify]   ✓ claude replied: ${JSON.stringify(f.content).slice(0, 100)}`);
      sawClaudeReply = true;
    }
    if (!sawError && f.type === "chat_error") {
      console.error(`[verify]   ✗ chat_error: ${f.reason}`);
      sawError = true;
    }
  }
  if ((sawEcho && sawClaudeReply) || sawError) break;
  await delay(200);
}

// ─── 6. Summary ───────────────────────────────────────────────────────────────
console.log("");
console.log("[verify] ────── summary ──────");
console.log(`[verify]   echo (pwa→hub→pwa):     ${sawEcho ? "PASS" : "FAIL"}`);
console.log(`[verify]   claude reply:           ${sawClaudeReply ? "PASS" : "FAIL"}`);
console.log(`[verify]   chat_error:             ${sawError ? "yes" : "no"}`);
console.log(`[verify]   total frames received:  ${inbox.length}`);

ws.close();
process.exit((sawEcho && !sawError) ? 0 : 1);
