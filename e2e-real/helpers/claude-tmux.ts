// Single entry point for launching real Claude Code under tmux in e2e-real.
//
// Background: Claude Code 2.1.144 only engages the channel-permission protocol
// when running under a real PTY in interactive mode and when the MCP plugin
// is loaded via --mcp-config + --dangerously-load-development-channels. See
// docs/superpowers/research/2026-05-20-p-mode-permission-spike.md for the
// empirical findings that motivated this helper.

import { writeFileSync } from "node:fs";
import * as tmux from "./tmux.ts";

export interface StartClaudeTmuxOpts {
  cwd: string;
  /** Single-shot prompt sent via send-keys + Enter after boot. */
  prompt: string;
  /** Unique tmux session name, e.g. `ccr-${scenario}-${Date.now()}`. */
  sessionName: string;
  /** Daemon Unix socket path; exposed to plugin via CC_REMOTE_SOCKET env. */
  socketPath: string;
  /** Path where the MCP config JSON should be written. */
  mcpConfigPath: string;
  /** Absolute path to packages/plugin/src/index.ts. */
  pluginEntryPath: string;
  /** Defaults to process.env.ANTHROPIC_API_KEY; throws if neither is set. */
  apiKey?: string;
  /** Defaults to "claude-haiku-4-5". */
  model?: string;
  /** Default 15_000. */
  bootTimeoutMs?: number;
  /** Default 60_000. */
  promptTimeoutMs?: number;
  /** If false, skip sending the initial prompt. Caller can use sendKeys later. */
  sendPrompt?: boolean;
}

export interface ClaudeTmuxHandle {
  sessionName: string;
  capturePane(): string;
  stop(): void;
  isAlive(): boolean;
}

async function dismissDialog(
  name: string,
  re: RegExp,
  timeoutMs: number,
  soft = false,
): Promise<boolean> {
  try {
    await tmux.waitForPattern(name, re, timeoutMs, `dialog ${re}`);
    if (process.env.CCR_E2E_DEBUG === "1") process.stderr.write(`[claude-tmux] dialog matched (${re}); sending Enter\n`);
    // Settle delay: TUI may still be rendering when our regex first matches.
    // Pressing Enter during a render frame can be dropped silently. 500ms is
    // empirically enough on this machine without bloating boot time.
    await new Promise((r) => setTimeout(r, 500));
    tmux.sendEnter(name);
    if (process.env.CCR_E2E_DEBUG === "1") process.stderr.write(`[claude-tmux] Enter sent\n`);
    return true;
  } catch (e) {
    if (process.env.CCR_E2E_DEBUG === "1") process.stderr.write(`[claude-tmux] dialog timeout (soft=${soft}): ${(e as Error).message.slice(0, 200)}\n`);
    if (soft) return false;
    throw e;
  }
}

export async function startClaudeTmux(opts: StartClaudeTmuxOpts): Promise<ClaudeTmuxHandle> {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  const haveAuthToken = !!authToken && !!baseUrl;
  if (!apiKey && !haveAuthToken) {
    throw new Error("startClaudeTmux: no Anthropic auth — set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN+ANTHROPIC_BASE_URL");
  }
  const model = opts.model ?? "claude-haiku-4-5";
  const bootTimeoutMs = opts.bootTimeoutMs ?? 15_000;

  // 1. Write MCP config.
  const mcpConfig = {
    mcpServers: {
      "cc-remote": {
        command: "bun",
        args: ["run", opts.pluginEntryPath],
        env: { CC_REMOTE_SOCKET: opts.socketPath },
      },
    },
  };
  writeFileSync(opts.mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

  // 2. Boot tmux session.
  tmux.newSession(opts.sessionName, opts.cwd);

  // From here on, any throw must kill the session we just created — otherwise
  // a partially-booted session leaks across scenarios and the next scenario's
  // `downCompose` sweep finds it long after the daemon socket has been ripped
  // out from under the plugin (root cause of inter-scenario hangs).
  try {
    // 3. Compose claude command. Auth env is prefixed inline so capture-pane
    //    diagnostics show what auth path is in use.
    const authPrefix = apiKey
      ? `ANTHROPIC_API_KEY=${apiKey}`
      : `ANTHROPIC_AUTH_TOKEN=${authToken} ANTHROPIC_BASE_URL=${baseUrl}`;
    const cmd = [
      authPrefix,
      `claude`,
      `--mcp-config ${opts.mcpConfigPath}`,
      `--dangerously-load-development-channels server:cc-remote`,
      `--model ${model}`,
      `--setting-sources project,local`,
    ].join(" ");

    tmux.sendKeys(opts.sessionName, cmd, true);

    // 4. Boot dialogs. Claude Code's dialog order changed between 2.1.144 and
    //    2.1.146 — current order is trust-workspace FIRST, then dev-channels.
    //    Both display "Enter to confirm". We dismiss them in two passes by
    //    waiting for "Enter to confirm", sending Enter, then waiting again.
    //    The trust dialog only renders for unfamiliar cwds, so the FIRST pass
    //    is soft (may already be on dev-channels). The SECOND pass is also
    //    soft because boot order can swap on different versions.
    await dismissDialog(opts.sessionName, /Enter to confirm/i, 20_000, true);
    // After Enter, Claude needs ~1-2s to swap dialogs. Poll for the next
    // "Enter to confirm" or for the interactive prompt directly.
    await new Promise((r) => setTimeout(r, 1_500));
    await dismissDialog(opts.sessionName, /Enter to confirm/i, 8_000, true);

    // 6. Wait for the interactive prompt. Claude Code 2.1.144 shows a `❯` cursor
    //    on a fresh line once boot is complete (preceded by "Try ..." placeholder
    //    text, but appearing before that hint is reliable enough).
    await tmux.waitForPattern(
      opts.sessionName,
      /❯\s+Try\s+|❯\s*$|>\s*$/m,
      bootTimeoutMs,
      "interactive prompt",
    );

    // 7. Send the prompt (unless the caller wants to drive it themselves).
    //    For long/complex prompts we send the text first, settle for a beat, then
    //    send Enter separately. This avoids a race observed in CC 2.1.144 where
    //    a single send-keys 'text' + 'Enter' lands in the input box but the
    //    Enter is not registered as a submit.
    if (opts.sendPrompt !== false) {
      tmux.sendKeys(opts.sessionName, opts.prompt, false);
      await new Promise((r) => setTimeout(r, 300));
      tmux.sendEnter(opts.sessionName);
    }

    return {
      sessionName: opts.sessionName,
      capturePane: () => tmux.capturePane(opts.sessionName),
      stop: () => tmux.killSession(opts.sessionName),
      isAlive: () => tmux.hasSession(opts.sessionName),
    };
  } catch (e) {
    try { tmux.killSession(opts.sessionName); } catch { /* best-effort */ }
    throw e;
  }
}
