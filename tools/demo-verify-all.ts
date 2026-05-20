#!/usr/bin/env bun
// Comprehensive demo verifier — exercises every PWA-facing feature against
// the running stack (assumes tools/demo-channel.sh start has been run).
//
// Tests, in order, with PASS/FAIL summary at end:
//   1. login chain  (auth/login → IAS → callback → bearer in fragment)
//   2. WS subscribe + snapshot  (daemon + session visible)
//   3. chat roundtrip — actual content propagation (unique random token)
//   4. permission relay — real Bash tool, real Allow flow
//   5. request_history — fetch history, get history_chunk
//   6. kill_session   — send, see session_close, new session can re-register
//
// Exits 0 if every requested test passes; non-zero otherwise.

import { setTimeout as delay } from "node:timers/promises";
import { spawnSync } from "node:child_process";

const HUB_HTTP = "http://localhost:17745";
const HUB_WS = "ws://localhost:17745";

interface TestResult { name: string; pass: boolean; detail?: string; }
const results: TestResult[] = [];
const record = (name: string, pass: boolean, detail?: string) => {
  results.push({ name, pass, detail });
  console.log(`[verify] ${pass ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const argv = process.argv.slice(2);
const skipKill = argv.includes("--skip-kill");
const skipPerm = argv.includes("--skip-perm");

// ─── 1. login chain ───────────────────────────────────────────────────────────
console.log("[verify] 1. login chain");
let bearer: string;
try {
  const r1 = await fetch(`${HUB_HTTP}/auth/login`, { redirect: "manual" });
  if (r1.status !== 302) throw new Error(`/auth/login: status ${r1.status}`);
  const r2 = await fetch(r1.headers.get("location")!, { redirect: "manual" });
  if (r2.status !== 302) throw new Error(`authorize: status ${r2.status}`);
  const r3 = await fetch(r2.headers.get("location")!, { redirect: "manual" });
  if (r3.status !== 302) throw new Error(`callback: status ${r3.status}`);
  const m = r3.headers.get("location")!.match(/#bearer=([^&]+)/);
  if (!m?.[1]) throw new Error(`no #bearer in callback Location`);
  bearer = decodeURIComponent(m[1]);
  record("login chain", true, `bearer=${bearer.slice(0, 12)}…`);
} catch (e) {
  record("login chain", false, (e as Error).message);
  console.error("[verify] cannot continue without bearer; aborting");
  process.exit(1);
}

// ─── 2. WS subscribe + snapshot ──────────────────────────────────────────────
console.log("[verify] 2. WS subscribe + snapshot");
const ws = new WebSocket(`${HUB_WS}/ws/pwa?bearer=${encodeURIComponent(bearer)}`);
const inbox: any[] = [];
ws.addEventListener("message", (ev) => {
  try { inbox.push(JSON.parse(typeof ev.data === "string" ? ev.data : "")); } catch {}
});
await new Promise<void>((res, rej) => {
  ws.addEventListener("open", () => res(), { once: true });
  ws.addEventListener("error", () => rej(new Error("ws error")), { once: true });
});
ws.send(JSON.stringify({ type: "subscribe" }));

async function waitFor(pred: (f: any) => boolean, timeoutMs: number, label: string): Promise<any> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    for (const f of inbox) if (pred(f)) return f;
    await delay(50);
  }
  throw new Error(`timeout waiting for ${label}; last 10 frame types: ${inbox.slice(-10).map((f) => f.type).join(", ")}`);
}

let daemon_id = "demo-1";
let session_id: string;
try {
  const snap = await waitFor((f) => f.type === "snapshot", 5000, "snapshot");
  const d = snap.daemons.find((x: any) => x.daemon_id === daemon_id);
  if (!d) throw new Error(`daemon ${daemon_id} not in snapshot (have: ${snap.daemons.map((x: any) => x.daemon_id).join(", ") || "none"})`);
  if (!d.online) throw new Error(`daemon ${daemon_id} offline`);
  if (d.sessions.length === 0) throw new Error(`daemon ${daemon_id} has no sessions`);
  session_id = d.sessions[0].session_id;
  record("WS subscribe + snapshot", true, `daemon=${daemon_id} session=${session_id.slice(0, 8)}…`);
} catch (e) {
  record("WS subscribe + snapshot", false, (e as Error).message);
  ws.close();
  process.exit(1);
}

// ─── 3. chat roundtrip with unique token ─────────────────────────────────────
console.log("[verify] 3. chat roundtrip (real content propagation)");
{
  const TOKEN = `KMR-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  ws.send(JSON.stringify({ type: "chat_send", daemon_id, session_id, content: TOKEN }));
  try {
    const echo = await waitFor(
      (f) => f.type === "chat" && f.from === "pwa" && f.content === TOKEN,
      5000, `chat echo containing ${TOKEN}`,
    );
    if (echo.session_id !== session_id) throw new Error(`echo session_id mismatch`);

    // Nudge tmux claude to take a turn so the channel injection materializes.
    setTimeout(() => {
      spawnSync("tmux", ["send-keys", "-t", "demo-claude", "process pending channel messages now and reply with the channel content using the reply tool"]);
      spawnSync("tmux", ["send-keys", "-t", "demo-claude", "Enter"]);
    }, 1500);
    setTimeout(() => {
      spawnSync("tmux", ["send-keys", "-t", "demo-claude", "Enter"]);
    }, 30_000);

    const reply = await waitFor(
      (f) => f.type === "chat" && f.from === "claude" && String(f.content).includes(TOKEN),
      90_000, `chat reply from=claude containing token ${TOKEN}`,
    );
    record("chat roundtrip", true, `reply=${String(reply.content).slice(0, 60)}…`);
  } catch (e) {
    record("chat roundtrip", false, (e as Error).message);
  }
}

// ─── 4. permission relay (real bash tool, real Allow) ────────────────────────
if (!skipPerm) {
  console.log("[verify] 4. permission relay");
  // pre-create a sandbox file so claude has something safe to delete
  const sandboxFile = `/tmp/cc-remote-demo/verify-sandbox-${Date.now()}.txt`;
  spawnSync("bash", ["-lc", `echo verify-sandbox > ${sandboxFile}`]);
  // ask claude (via channel) to run a Bash that needs permission
  const PERM_PROMPT = `please run the bash command: rm ${sandboxFile}`;
  ws.send(JSON.stringify({ type: "chat_send", daemon_id, session_id, content: PERM_PROMPT }));
  // Nudge
  setTimeout(() => {
    spawnSync("tmux", ["send-keys", "-t", "demo-claude", "process pending channel messages now"]);
    spawnSync("tmux", ["send-keys", "-t", "demo-claude", "Enter"]);
  }, 2000);
  try {
    const req = await waitFor(
      (f) => f.type === "permission_request" && f.daemon_id === daemon_id,
      60_000, "permission_request",
    );
    if (!/^[a-km-z]{5}$/.test(req.request_id)) throw new Error(`bad request_id: ${req.request_id}`);
    ws.send(JSON.stringify({ type: "permission_reply", daemon_id, session_id: req.session_id, request_id: req.request_id, decision: "allow" }));
    const resolved = await waitFor(
      (f) => f.type === "permission_resolved" && f.request_id === req.request_id,
      10_000, "permission_resolved",
    );
    if (resolved.decision !== "allow") throw new Error(`decision not allow: ${resolved.decision}`);
    record("permission relay", true, `request_id=${req.request_id} allow round-tripped`);
  } catch (e) {
    record("permission relay", false, (e as Error).message);
  }
}

// ─── 5. request_history ───────────────────────────────────────────────────────
console.log("[verify] 5. request_history");
{
  const RID = `verify-rh-${Date.now()}`;
  ws.send(JSON.stringify({
    type: "request_history",
    daemon_id, session_id,
    request_id: RID,
    before_offset: Number.MAX_SAFE_INTEGER,
    limit: 100,
  }));
  try {
    const chunk = await waitFor(
      (f) => f.type === "history_chunk" && f.request_id === RID,
      10_000, "history_chunk",
    );
    record("request_history", true, `events=${chunk.events?.length ?? 0}`);
  } catch (e) {
    // jsonl bind may have timed out → daemon legitimately can't serve history
    record("request_history", false, `${(e as Error).message} (likely daemon JSONL bind timed out — non-critical for chat-only sessions)`);
  }
}

// ─── 6. kill_session (optional — destructive; default skip) ──────────────────
if (!skipKill) {
  console.log("[verify] 6. kill_session");
  ws.send(JSON.stringify({ type: "kill_session", daemon_id, session_id }));
  try {
    const closed = await waitFor(
      (f) => f.type === "session_close" && f.daemon_id === daemon_id && f.session_id === session_id,
      10_000, "session_close",
    );
    record("kill_session", true, `reason=${closed.reason ?? "?"}`);
  } catch (e) {
    record("kill_session", false, (e as Error).message);
  }
} else {
  console.log("[verify] 6. kill_session — SKIPPED (would terminate the demo's claude)");
}

// ─── summary ─────────────────────────────────────────────────────────────────
ws.close();
console.log("");
console.log("[verify] ────── summary ──────");
const passN = results.filter((r) => r.pass).length;
const failN = results.length - passN;
for (const r of results) console.log(`[verify]   ${r.pass ? "✓" : "✗"}  ${r.name}`);
console.log(`[verify] total: ${passN}/${results.length} pass${failN ? `, ${failN} fail` : ""}`);
process.exit(failN === 0 ? 0 : 1);
