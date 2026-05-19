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

  // 4. Dev-channels confirmation. Observed text in CC 2.1.144:
  //    "WARNING: Loading development channels … 1. I am using this for local
  //    development / 2. Exit". Default-1 highlighted; Enter accepts.
  await dismissDialog(opts.sessionName, /Loading development channels|loading\s+development\s+channels/i, 12_000, false);

  // 5. Workspace-trust dialog (per-cwd, may already be remembered).
  //    Observed text: "Quick safety check: Is this a project you created or
  //    one you trust?" → 1. Yes / 2. No.
  await dismissDialog(
    opts.sessionName,
    /trust.*workspace|trust.*folder|safety check|created or one you trust/i,
    8_000,
    true,
  );

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
