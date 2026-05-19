// Smoke test for helpers/claude-tmux. Real Claude run + mock daemon.
//
// Skipped by default — set CC_REMOTE_E2E_REAL_CLAUDE_TMUX_SMOKE=1 to opt in.
// This is intentionally not part of the merge gate; the actual coverage comes
// from the scenario tests in tests/.
//
// When enabled, this test:
//  - spawns an in-process Bun Unix socket "mock daemon" that auto-acks register
//  - launches `claude` via startClaudeTmux with prompt "say hi"
//  - asserts a `register` frame arrives within 30s
//
// Cost: ~$0.01 on Haiku.

import { test, expect, beforeAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FrameDecoder, encodeFrame } from "@cc-remote/proto";
import { startClaudeTmux } from "../../helpers/claude-tmux.ts";

const optIn = process.env.CC_REMOTE_E2E_REAL_CLAUDE_TMUX_SMOKE === "1";
const apiKeyPresent = !!process.env.ANTHROPIC_API_KEY;
const tmuxAvailable = spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0;
const claudeAvailable = spawnSync("claude", ["--version"], { encoding: "utf8" }).status === 0;
const enabled = optIn && apiKeyPresent && tmuxAvailable && claudeAvailable;

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..", "..");

test.if(enabled)("claude-tmux smoke: plugin registers with mock daemon", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-tmux-smoke-"));
  const socketPath = join(dir, "daemon.sock");
  const mcpPath = join(dir, "mcp.json");
  const pluginEntry = join(repoRoot, "packages", "plugin", "src", "index.ts");

  // In-process mock daemon (Bun.listen on Unix socket).
  let registered = false;
  const server = Bun.listen({
    unix: socketPath,
    socket: {
      open(socket) {
        (socket as unknown as { _dec: FrameDecoder })._dec = new FrameDecoder();
      },
      data(socket, chunk) {
        const dec = (socket as unknown as { _dec: FrameDecoder })._dec;
        for (const f of dec.push(new Uint8Array(chunk)) as Array<{ type: string }>) {
          if (f.type === "register") {
            registered = true;
            socket.write(encodeFrame({ type: "ack", ref: "register" }));
          }
        }
      },
    },
  });

  let claude: { stop: () => void } | undefined;
  try {
    claude = await startClaudeTmux({
      cwd: dir,
      prompt: "say hi",
      sessionName: `ccr-smoke-${Date.now()}`,
      socketPath,
      mcpConfigPath: mcpPath,
      pluginEntryPath: pluginEntry,
    });
    const deadline = Date.now() + 30_000;
    while (!registered && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(registered).toBe(true);
  } finally {
    claude?.stop();
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

if (!enabled) {
  beforeAll(() => {
    if (!optIn) console.log("[claude-tmux.test.ts] skipped: set CC_REMOTE_E2E_REAL_CLAUDE_TMUX_SMOKE=1 to enable");
    else if (!apiKeyPresent) console.log("[claude-tmux.test.ts] skipped: ANTHROPIC_API_KEY missing");
    else if (!tmuxAvailable) console.log("[claude-tmux.test.ts] skipped: tmux not on PATH");
    else if (!claudeAvailable) console.log("[claude-tmux.test.ts] skipped: claude not on PATH");
  });
  test.skip("claude-tmux smoke: opt-in only", () => {});
}
