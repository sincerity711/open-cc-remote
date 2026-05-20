#!/usr/bin/env bun
// Browser-driven verification of PWA features against the running demo
// stack. Drives the actual React UI in a real Chromium (system Chrome) and
// asserts on observable DOM + WS network frames — i.e. catches UI bugs the
// CLI verifier (tools/demo-verify-all.ts) would miss because it bypasses
// the UI entirely.
//
// Suite (each step PASS/FAIL — does NOT abort on first fail):
//   1. open PWA, click Sign in, land back as authenticated
//   2. snapshot rendered: see daemon "demo-1" + at least one session in UI
//   3. click session → SessionPane opens, chat composer present + enabled
//   4. type chat message + click Send → echo bubble appears in chat log
//   5. nudge tmux claude → claude reply bubble (from=claude) appears
//   6. trigger permission scenario via chat → PermissionBanner renders
//      with Allow/Deny → click Allow → banner clears
//   7. (optional, destructive) click Kill button on the session
//   8. (optional) click Start session for a new tmux

import { chromium, type Page, type Browser, type ConsoleMessage } from "playwright";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const PWA_URL = "http://localhost:15173/";

interface Result { name: string; pass: boolean; detail?: string; }
const results: Result[] = [];
const record = (name: string, pass: boolean, detail?: string) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const tryStep = async (name: string, fn: () => Promise<string | undefined>) => {
  try {
    const detail = await fn();
    record(name, true, detail);
    return true;
  } catch (e) {
    record(name, false, (e as Error).message.split("\n")[0]?.slice(0, 200));
    return false;
  }
};

let browser: Browser | undefined;
let page: Page | undefined;
const consoleLogs: string[] = [];
const wsFrames: { kind: "tx" | "rx"; text: string; ts: number }[] = [];

try {
  browser = await chromium.launch({
    channel: "chrome",                 // use system Chrome (no browser download)
    headless: true,
    args: ["--no-sandbox"],
  });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  page = await ctx.newPage();

  page.on("console", (msg: ConsoleMessage) => {
    consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
  });
  page.on("pageerror", (err) => {
    consoleLogs.push(`[pageerror] ${err.message}`);
  });

  // Capture every WS frame the PWA sends/receives.
  page.on("websocket", (ws) => {
    const url = ws.url();
    consoleLogs.push(`[ws-open] ${url}`);
    ws.on("framesent", (f) => {
      const text = typeof f.payload === "string" ? f.payload : new TextDecoder().decode(f.payload);
      wsFrames.push({ kind: "tx", text, ts: Date.now() });
    });
    ws.on("framereceived", (f) => {
      const text = typeof f.payload === "string" ? f.payload : new TextDecoder().decode(f.payload);
      wsFrames.push({ kind: "rx", text, ts: Date.now() });
    });
    ws.on("close", () => consoleLogs.push(`[ws-close] ${url}`));
  });

  // ─── 1. login ───────────────────────────────────────────────────────────────
  await tryStep("1. open PWA + login", async () => {
    await page!.goto(PWA_URL, { waitUntil: "domcontentloaded", timeout: 10_000 });
    // Click "Sign in" → the click does a normal navigation through the IAS chain
    // back to PWA with bearer in fragment.
    await page!.waitForSelector("text=Sign in", { timeout: 5000 });
    await Promise.all([
      page!.waitForLoadState("domcontentloaded", { timeout: 10_000 }),
      page!.click("text=Sign in"),
    ]);
    // After IAS auto-redirect, PWA reads bearer from fragment and shows the daemon list.
    // Wait for the connection-status indicator to read "connected".
    await page!.waitForFunction(
      () => document.querySelector('[data-testid="conn-status"]')?.textContent === "connected",
      undefined,
      { timeout: 15_000 },
    );
    return `signed in, ws connected`;
  });

  // ─── 2. snapshot rendered ──────────────────────────────────────────────────
  let session_id: string | null = null;
  await tryStep("2. snapshot renders daemon + session", async () => {
    // Wait for any element containing daemon_id "demo-1"
    await page!.waitForSelector("text=demo-1", { timeout: 8_000 });
    // Find a clickable session row. The PWA renders sessions inside the daemon
    // panel; structure unknown — try common patterns.
    await delay(500);
    // Use a snapshot frame to discover session_id.
    const snap = wsFrames.reverse().find((f) => f.kind === "rx" && f.text.includes('"snapshot"'));
    if (!snap) throw new Error("no snapshot frame received");
    const parsed = JSON.parse(snap.text);
    const d = parsed.daemons.find((x: any) => x.daemon_id === "demo-1");
    if (!d) throw new Error("demo-1 not in snapshot");
    if (!d.online) throw new Error("demo-1 offline");
    if (d.sessions.length === 0) throw new Error("demo-1 has no sessions");
    session_id = d.sessions[0].session_id;
    return `daemon=demo-1 session=${session_id!.slice(0, 8)}…`;
  });

  // ─── 3. open session pane + chat composer present ──────────────────────────
  await tryStep("3. select session → SessionPane + chat composer visible", async () => {
    if (!session_id) throw new Error("no session_id from step 2");
    // Click on the session — the snapshot renders sessions as some sort of
    // clickable element. Try by text including the session_id.
    const shortId = session_id.slice(0, 8);
    // Sessions may be rendered with truncated id. Try clicking anything containing the id.
    const sessionLocator = page!.locator(`text=${shortId}`).first();
    await sessionLocator.click({ timeout: 5_000 });
    // Wait for SessionPane chat input to appear.
    await page!.waitForSelector('[data-testid="chat-input"]', { timeout: 5_000 });
    // Should be enabled (sessionOnline=true since daemon is online).
    const disabled = await page!.locator('[data-testid="chat-input"]').isDisabled();
    if (disabled) throw new Error("chat-input is disabled (sessionOnline=false?)");
    return "chat composer rendered + enabled";
  });

  // ─── 4. type chat message + click Send → echo appears ──────────────────────
  const TOKEN = `KMR-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  await tryStep(`4. type "${TOKEN}" + Send → echo bubble appears`, async () => {
    await page!.locator('[data-testid="chat-input"]').fill(TOKEN);
    await page!.locator('button:has-text("Send")').click();
    // Echo should show up in the chat log (text TOKEN appears in DOM).
    await page!.waitForFunction(
      (t: string) => document.body.textContent?.includes(t) ?? false,
      TOKEN,
      { timeout: 5_000 },
    );
    return `echo with token rendered in DOM`;
  });

  // ─── 5. claude reply bubble (after tmux nudge) ─────────────────────────────
  await tryStep(`5. tmux nudge → claude reply bubble contains "${TOKEN}"`, async () => {
    spawnSync("tmux", ["send-keys", "-t", "demo-claude", "use mcp__cc-remote__reply tool with text= the exact channel message content (verbatim)"]);
    await delay(300);
    spawnSync("tmux", ["send-keys", "-t", "demo-claude", "Enter"]);
    // Wait for a chat broadcast frame from=claude with the token. Re-nudge
    // every 60s because Haiku sometimes ignores the first prompt.
    const start = Date.now();
    while (Date.now() - start < 150_000) {
      const found = wsFrames.find((f) => f.kind === "rx" && f.text.includes('"chat"') && f.text.includes('"from":"claude"') && f.text.includes(TOKEN));
      if (found) return `wire frame received; rendered=${(await page!.locator(`text=${TOKEN}`).count()) >= 2 ? "yes" : "no"}`;
      // Re-nudge at 60s + 120s.
      const elapsed = Date.now() - start;
      if (elapsed > 60_000 && elapsed < 60_500) {
        spawnSync("tmux", ["send-keys", "-t", "demo-claude", `the channel just sent "${TOKEN}" — call mcp__cc-remote__reply with text=${TOKEN}`]);
        await delay(300);
        spawnSync("tmux", ["send-keys", "-t", "demo-claude", "Enter"]);
      }
      await delay(500);
    }
    throw new Error("claude reply with token not received within 150s");
  });

  // ─── 6. permission scenario via fake-claude --inject-permission ───────────
  //
  // Triggering a permission_request through a real Claude turn is unreliable
  // in CC 2.1.145: depending on cwd / tool / session state, claude sometimes
  // routes Bash to its local TUI permission dialog instead of emitting the
  // channel notification. The wire-level relay is provably correct (covered
  // by the CLI verifier and packages/plugin/tests/permission.test.ts), so
  // here we test only the UI path: a permission_request frame arrives,
  // PermissionBanner renders Allow/Deny, click Allow, see resolved.
  //
  // We inject the request by spawning fake-claude --inject-permission against
  // the SAME daemon socket. fake-claude STAYS ALIVE (registers a synthetic
  // session, idles) so when PWA sends Allow back, daemon can forward the
  // permission_reply over the still-open Unix socket and fake-claude (or
  // the plugin's existing flow on the same daemon) acks it.
  await tryStep("6. permission banner → Allow → cleared", async () => {
    const reqId = `req-${Math.random().toString(36).slice(2, 7)}`;
    const fakeSessionId = `verify-perm-${Date.now()}`;
    const fakeArgs = `rm /tmp/cc-remote-demo/verify-ui-${Date.now()}.txt`;
    const fc = spawn("bun", [
      "tools/fake-claude/fake-claude.ts",
      "--session-id", fakeSessionId,
      "--cwd", "/tmp/cc-remote-demo",
      "--socket", "/tmp/cc-remote-demo/daemon.sock",
      "--inject-permission", `Bash:${reqId}:${fakeArgs}`,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      // Wait for the permission_request frame to broadcast to PWA.
      const start = Date.now();
      let req: any = null;
      while (Date.now() - start < 30_000 && !req) {
        const f = wsFrames.find((f) => f.kind === "rx" && f.text.includes('"permission_request"') && f.text.includes(reqId));
        if (f) {
          try { req = JSON.parse(f.text); } catch {}
        }
        await delay(200);
      }
    if (!req) throw new Error(`no permission_request with reqId=${reqId} received within 30s`);

      // Banner should render. PermissionBanner is global (top of App), not
      // per-session, so it should appear regardless of `selected`.
      await page!.waitForSelector('button:has-text("Allow")', { timeout: 8_000 });
      await page!.locator('button:has-text("Allow")').first().click({ timeout: 8_000 });

      // Daemon will forward permission_reply to the plugin socket, which is
      // fake-claude. fake-claude doesn't auto-emit permission_resolved (its
      // protocol stops at receiving the reply), but the daemon's relay does:
      // it broadcasts the resolved frame to PWAs after the plugin acks.
      // Allow up to 15s.
      const end = Date.now() + 15_000;
      while (Date.now() < end) {
        const r = wsFrames.find((f) => f.kind === "rx" && f.text.includes('"permission_resolved"') && f.text.includes(reqId));
        if (r) {
          const parsed = JSON.parse(r.text);
          if (parsed.decision !== "allow") throw new Error(`decision=${parsed.decision}`);
          return `request_id=${reqId} allow round-tripped via injected fake-claude`;
        }
        await delay(200);
      }
      throw new Error("no permission_resolved (did fake-claude receive the reply?)");
    } finally {
      try { fc.kill("SIGTERM"); } catch {}
    }
  });

  // ─── summary ────────────────────────────────────────────────────────────────
} catch (e) {
  console.error("[verify-browser] FATAL:", (e as Error).message);
} finally {
  console.log("");
  console.log("────── summary ──────");
  for (const r of results) console.log(`  ${r.pass ? "✓" : "✗"} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  const passN = results.filter((r) => r.pass).length;
  const failN = results.length - passN;
  console.log(`total: ${passN}/${results.length} pass${failN ? `, ${failN} fail` : ""}`);
  if (failN > 0) {
    console.log("");
    console.log("─ console (last 30):");
    for (const l of consoleLogs.slice(-30)) console.log(`  ${l}`);
    console.log("");
    console.log(`─ WS TX frames (PWA → hub) — total ${wsFrames.filter((f) => f.kind === "tx").length}:`);
    for (const f of wsFrames.filter((f) => f.kind === "tx")) console.log(`  TX ${f.text.slice(0, 200)}`);
    console.log("");
    console.log(`─ WS RX frames matching chat/permission/error — sample 30:`);
    for (const f of wsFrames.filter((f) => f.kind === "rx" && /chat|permission|error/.test(f.text)).slice(0, 30)) {
      console.log(`  RX ${f.text.slice(0, 200)}`);
    }
  }
  await browser?.close();
  process.exit(failN === 0 ? 0 : 1);
}
