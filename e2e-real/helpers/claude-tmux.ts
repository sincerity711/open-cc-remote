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
    // Press Enter to confirm the default highlighted choice.
    tmux.sendEnter(name);
    return true;
  } catch (e) {
    if (soft) return false;
    throw e;
  }
}

export async function startClaudeTmux(opts: StartClaudeTmuxOpts): Promise<ClaudeTmuxHandle> {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("startClaudeTmux: ANTHROPIC_API_KEY missing (and opts.apiKey not set)");
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

  // 3. Compose claude command. ANTHROPIC_API_KEY is prefixed inline to be
  //    crystal-clear for diagnostic capture-pane output.
  const cmd = [
    `ANTHROPIC_API_KEY=${apiKey}`,
    `claude`,
    `--mcp-config ${opts.mcpConfigPath}`,
    `--dangerously-load-development-channels server:cc-remote`,
    `--model ${model}`,
    `--setting-sources project,local`,
  ].join(" ");

  tmux.sendKeys(opts.sessionName, cmd, true);

  // 4. Dev-channels confirmation. The exact text observed in the spike:
  //    "WARNING: Loading development channels … 1. I am using this for local
  //    development / 2. Exit". Default-1 highlighted; Enter accepts.
  await dismissDialog(opts.sessionName, /Allow.*development.*channels/i, 10_000, true)
    .then(async (hit) => {
      if (!hit) {
        // Try a wider net — the wording may be "loading development channels",
        // "developer channels", etc.
        await dismissDialog(opts.sessionName, /develop(ment|er).*channel/i, 5_000, true);
      }
    });

  // 5. Workspace-trust dialog (per-cwd, may already be remembered).
  await dismissDialog(opts.sessionName, /trust.*workspace|trust.*folder|safety check.*trust/i, 8_000, true);

  // 6. Wait for the interactive prompt. Claude shows a `>` cursor on a fresh
  //    line once boot is complete.
  await tmux.waitForPattern(
    opts.sessionName,
    /(?:^|\n)\s*>\s*(?:\n|$)/m,
    bootTimeoutMs,
    "interactive prompt",
  );

  // 7. Send the prompt (unless the caller wants to drive it themselves).
  if (opts.sendPrompt !== false) {
    tmux.sendKeys(opts.sessionName, opts.prompt, true);
  }

  return {
    sessionName: opts.sessionName,
    capturePane: () => tmux.capturePane(opts.sessionName),
    stop: () => tmux.killSession(opts.sessionName),
    isAlive: () => tmux.hasSession(opts.sessionName),
  };
}
