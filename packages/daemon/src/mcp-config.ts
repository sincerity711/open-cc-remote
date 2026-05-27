import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

export interface EnsureMcpConfigInput {
  state_dir: string;
  /** Absolute path to the plugin entry script. Resolved at daemon startup. */
  plugin_entry: string;
  /** Path to the daemon Unix socket; the plugin reads CC_REMOTE_SOCKET. */
  socket_path: string;
  /**
   * `bun` executable to invoke the plugin with. We pin to the bun the daemon
   * itself was launched with (process.execPath) so single-binary installs
   * don't require a separate bun on PATH.
   */
  bun_path: string;
}

export interface EnsureMcpConfigResult {
  /** Absolute path to the (possibly newly written) mcp-config.json. */
  path: string;
  /** True if the file was just created; false if it existed already. */
  created: boolean;
}

/**
 * Idempotently writes <state_dir>/mcp-config.json so a freshly-installed
 * daemon can boot Claude Code with the plugin without any sibling tooling.
 *
 * The file is written exactly once — if it already exists we leave it
 * untouched so users can hand-edit (e.g. add other MCP servers). To force
 * regeneration: delete the file.
 *
 * Pre-rework, the demo script wrote this file at /tmp/cc-remote-demo/. The
 * daemon now owns it so non-demo users get a working setup out of the box.
 */
export function ensureMcpConfig(input: EnsureMcpConfigInput): EnsureMcpConfigResult {
  const path = join(input.state_dir, "mcp-config.json");
  if (existsSync(path)) return { path, created: false };
  try { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); } catch {}
  const body = {
    mcpServers: {
      "cc-remote": {
        command: input.bun_path,
        args: ["run", input.plugin_entry],
        env: { CC_REMOTE_SOCKET: input.socket_path },
      },
    },
  };
  writeFileSync(path, JSON.stringify(body, null, 2) + "\n");
  return { path, created: true };
}
