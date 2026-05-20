// Scenario 12 — chat round-trip with real claude.
//
// PWA sends chat_send → daemon translates to chat_in → plugin injects as
// <channel source="cc-remote" ...> → real claude responds with the `reply`
// tool → plugin emits chat_out → hub broadcasts → PWA receives.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { upCompose, downCompose } from "../helpers/compose.ts";
import { startClaudeTmux } from "../helpers/claude-tmux.ts";
import { loginAndConnect } from "../helpers/pwa-client.ts";
import { pairAndStartDaemon } from "../helpers/scenario.ts";
import { preflightOrThrow } from "../helpers/preflight.ts";
import * as tmux from "../helpers/tmux.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const pluginEntry = resolve(repoRoot, "packages", "plugin", "src", "index.ts");

beforeAll(async () => {
  preflightOrThrow();
  await upCompose();
}, 300_000);
afterAll(async () => { await downCompose(); }, 60_000);

test("PWA chat_send → real claude reply tool → PWA chat broadcast", async () => {
  const daemon_id = `chat-${Date.now()}`;
  const handle = await pairAndStartDaemon({
    daemon_id,
    hub_url: "ws://localhost:7745",
    hub_http: "http://localhost:7745",
  });

  const pwa = await loginAndConnect({ hub_http: "http://localhost:7745", hub_ws: "ws://localhost:7745" });

  let claude: { stop: () => void; capturePane: () => string; sessionName: string } | undefined;
  try {
    // The chat content carries a UNIQUE token only present in the chat_send
    // (not in the priming prompt and not in the tmux nudge). Claude must
    // therefore have actually received the channel injection — including the
    // unique token — to echo it back. This catches schema-validation drops
    // that the previous "ACK" test missed (a Zod ts-type mismatch silently
    // killed the entire channel relay until 2026-05-21).
    const TOKEN = `KMR-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;

    claude = await startClaudeTmux({
      cwd: "/tmp",
      // Initial prompt does NOT contain the token. It only tells claude to
      // forward whatever channel content arrives, by calling the reply tool.
      prompt: "You are connected to cc-remote. When a `<channel source=\"cc-remote\">` message arrives, call the MCP tool `mcp__cc-remote__reply` with arguments {\"text\": <the exact channel content verbatim, no quotes, no prose>}. Acknowledge with the single word: ready.",
      sendPrompt: true,
      sessionName: `ccr-chat-${daemon_id}`,
      socketPath: handle.socket_path,
      mcpConfigPath: `${handle.state_dir}/cc-remote-mcp.json`,
      pluginEntryPath: pluginEntry,
    });

    // Wait for the daemon's session to surface in PWA snapshot/session_open.
    const opened = await pwa.waitFor((f) => {
      if (f.type === "snapshot") {
        const d = f.daemons.find((dd) => dd.daemon_id === daemon_id);
        if (d && d.sessions.length > 0) return f;
      }
      if (f.type === "session_open" && f.daemon_id === daemon_id) return f;
      return false;
    }, 30_000, "session for chat-daemon");
    let session_id: string;
    if (opened.type === "snapshot") {
      const d = opened.daemons.find((dd) => dd.daemon_id === daemon_id)!;
      session_id = d.sessions[0]!.session_id;
    } else if (opened.type === "session_open") {
      session_id = opened.session.session_id;
    } else {
      throw new Error(`unexpected matched frame type: ${(opened as { type: string }).type}`);
    }

    // Send chat_send with the unique token as the content.
    pwa.send({
      type: "chat_send",
      daemon_id,
      session_id,
      content: TOKEN,
    });

    // Echo (from=pwa) should be near-immediate.
    const echo = await pwa.waitFor(
      (f) => f.type === "chat" && (f as any).from === "pwa" && (f as any).daemon_id === daemon_id ? f : false,
      5_000, "chat echo from=pwa",
    );
    expect((echo as any).session_id).toBe(session_id);
    expect((echo as any).content).toBe(TOKEN);

    // The chat injection arrives on Claude's next turn. Trigger a turn via
    // tmux. The nudge prompt does NOT contain the token — claude must read
    // it from the channel content to echo it back.
    const triggerTurn = async () => {
      try {
        tmux.sendKeys(claude!.sessionName, "process pending channel messages now", false);
        await new Promise((r) => setTimeout(r, 300));
        tmux.sendEnter(claude!.sessionName);
      } catch { /* ignore */ }
    };
    setTimeout(() => { void triggerTurn(); }, 3_000);
    setTimeout(() => { void triggerTurn(); }, 35_000);
    setTimeout(() => { void triggerTurn(); }, 75_000);

    // Claude calls reply tool → chat_out → broadcast (from=claude). Allow
    // generous time for a real model turn (plus possible re-nudges).
    // The reply MUST contain the token, proving channel content actually
    // reached the model.
    const reply = await pwa.waitFor(
      (f) => {
        if (f.type !== "chat") return false;
        const cf = f as any;
        if (cf.from !== "claude" || cf.daemon_id !== daemon_id) return false;
        return String(cf.content).includes(TOKEN) ? f : false;
      },
      120_000, `chat reply from=claude containing token ${TOKEN}`,
    );
    expect((reply as any).user).toBeNull();
    expect((reply as any).session_id).toBe(session_id);
    expect((reply as any).content).toContain(TOKEN);
  } catch (e) {
    if (claude) {
      try {
        process.stderr.write(`[scenario 12] failure; pane:\n${claude.capturePane()}\n`);
      } catch { /* ignore */ }
    }
    throw e;
  } finally {
    pwa.close();
    claude?.stop();
    await handle.cleanup();
  }
}, 240_000);
