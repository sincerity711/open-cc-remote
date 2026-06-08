#!/usr/bin/env bun
import { hostname, homedir } from "node:os";
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, chmodSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { defaultStateDir } from "../src/config.ts";
import { getOrCreateKeypair } from "../src/keystore.ts";

interface ParsedArgs {
  [key: string]: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const cur = argv[i];
    if (!cur) continue;
    if (cur.startsWith("--")) {
      const key = cur.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) { out[key] = next; i++; }
      else { out[key] = "true"; }
    }
  }
  return out;
}

async function cmdPair(args: ParsedArgs): Promise<void> {
  const hub = args.hub;
  const code = args.code;
  const daemon_id = args["daemon-id"] ?? hostname();
  if (!hub) throw new Error("--hub is required");
  if (!code) throw new Error("--code is required");

  const stateDir = defaultStateDir();
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const kp = await getOrCreateKeypair(stateDir);

  const httpHub = hub.replace(/^ws(s?):\/\//, "http$1://");
  const body = {
    code, daemon_id, hostname: hostname(),
    public_key_jwk: kp.publicJwk,
  };
  const res = await fetch(`${httpHub}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`pair failed: ${res.status} ${text}`);
  }
  const result = (await res.json()) as { jwt: string; daemon_id: string; exp: number };

  const configPath = join(stateDir, "config.json");
  // Merge into any existing config.json so prior settings (allow_kill,
  // allow_start, allowed_cwd_prefix, spawn_command, idle_window_ms, …) survive
  // re-pairing. Only daemon_id + hub_url are authoritative from the pair flow.
  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed && typeof parsed === "object") existing = parsed;
    } catch (e) {
      process.stderr.write(`cc-remote: warning — could not parse existing config.json (${(e as Error).message}); overwriting\n`);
    }
  }
  const merged = { ...existing, daemon_id, hub_url: hub };
  // Atomic write: tmp + rename so a crash mid-write can't truncate config.
  const tmp = `${configPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(merged, null, 2) + "\n");
  try { chmodSync(tmp, 0o600); } catch {}
  renameSync(tmp, configPath);

  const statePath = join(stateDir, "state.json");
  writeFileSync(
    statePath,
    JSON.stringify({ jwt: result.jwt, paired_at: Date.now(), exp: result.exp }, null, 2) + "\n",
  );
  try { chmodSync(statePath, 0o600); } catch {}

  process.stdout.write(`paired as daemon_id=${daemon_id}\n`);
  process.stdout.write(`  state dir: ${stateDir}\n`);
  process.stdout.write(`  hub:       ${hub}\n`);
  process.stdout.write(`  jwt exp:   ${new Date(result.exp * 1000).toISOString()}\n`);
}

async function cmdDaemon(): Promise<void> {
  await import("../src/index.ts");
}

async function cmdDaemonRotateToken(): Promise<void> {
  const { existsSync, readFileSync, writeFileSync, chmodSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { signDpop } = await import("../src/dpop.ts");
  const { loadConfig } = await import("../src/config.ts");

  const cfg = loadConfig();
  const statePath = cfg.state_path;
  if (!existsSync(statePath)) throw new Error(`no state.json at ${statePath}; run 'cc-remote pair' first`);
  const state = JSON.parse(readFileSync(statePath, "utf8")) as { jwt?: string };
  if (!state.jwt) throw new Error("state.json missing jwt");

  const kp = await getOrCreateKeypair(cfg.state_dir);
  const httpHub = cfg.hub_url.replace(/^ws(s?):\/\//, "http$1://");
  const refreshUrl = `${httpHub}/pair/refresh`;
  const dpop = await signDpop(kp.privateJwk, "POST", refreshUrl);

  const res = await fetch(refreshUrl, {
    method: "POST",
    headers: {
      authorization: `DPoP ${state.jwt}`,
      dpop,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`refresh failed: ${res.status} ${body}`);
  }
  const result = await res.json() as { jwt: string; exp: number };

  writeFileSync(statePath, JSON.stringify({ jwt: result.jwt, paired_at: Date.now(), exp: result.exp }, null, 2) + "\n");
  try { chmodSync(statePath, 0o600); } catch {}

  process.stdout.write(`token rotated; new exp ${new Date(result.exp * 1000).toISOString()}\n`);
}

async function cmdInstall(args: ParsedArgs): Promise<void> {
  const {
    detectPlatform, unitPath, unitContent, installCommands,
  } = await import("../src/installer.ts");
  const { loginShellPath } = await import("../src/login-shell.ts");

  const platform = detectPlatform();
  if (platform === "unsupported") {
    throw new Error(`unsupported platform: ${process.platform}; only darwin/linux are supported`);
  }
  const dry = args["dry-run"] === "true";

  const bunPath = process.env.BUN_INSTALL
    ? `${process.env.BUN_INSTALL}/bin/bun`
    : (process.execPath || "bun");
  const ccRemoteBin = (() => {
    const url = import.meta.url;
    if (url.startsWith("file://")) return url.slice("file://".length);
    return url;
  })();
  const stateDir = defaultStateDir();
  const path = unitPath(platform);
  // Capture interactive PATH so the daemon (and the things it spawns: tmux,
  // claude, git, hooks) sees what the user sees in their terminal — not the
  // systemd/launchd-stripped default. Skip if no login shell answered or if
  // the user passed --no-path-env (e.g. for reproducible test runs).
  const wantPathEnv = args["no-path-env"] !== "true";
  const pathEnv = wantPathEnv ? loginShellPath() : null;
  if (wantPathEnv && !pathEnv) {
    process.stderr.write(
      `cc-remote install: warning — could not capture PATH via login shell;\n` +
      `  unit will rely on the platform default. If 'claude' isn't found at\n` +
      `  runtime, set spawn_command to an absolute path in config.json.\n`,
    );
  }
  const content = unitContent(platform, {
    bun_path: bunPath,
    cc_remote_bin: ccRemoteBin,
    state_dir: stateDir,
    path_env: pathEnv ?? undefined,
  });
  const cmds = installCommands(platform, path);

  process.stdout.write(`platform:        ${platform}\n`);
  process.stdout.write(`unit file:       ${path}\n`);
  process.stdout.write(`state dir:       ${stateDir}\n`);
  process.stdout.write(`bun:             ${bunPath}\n`);
  process.stdout.write(`cc-remote bin:   ${ccRemoteBin}\n`);
  process.stdout.write(`PATH baked:      ${pathEnv ? "yes" : "no"}\n`);
  if (dry) {
    process.stdout.write(`\n--- unit content ---\n${content}\n--- end ---\n`);
    if (cmds.reload.length) process.stdout.write(`would run: ${cmds.reload.join(" ")}\n`);
    process.stdout.write(`would run: ${cmds.enable.join(" ")}\n`);
    process.stdout.write(`would run: ${cmds.start.join(" ")}\n`);
    return;
  }

  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(path, content);
  process.stdout.write(`✔ wrote ${path}\n`);

  for (const argv of [cmds.reload, cmds.enable, cmds.start]) {
    if (argv.length === 0) continue;
    const r = spawnSync(argv[0]!, argv.slice(1), { stdio: "inherit" });
    if (r.status !== 0) throw new Error(`command failed: ${argv.join(" ")} (status ${r.status})`);
  }
  process.stdout.write(`✔ daemon installed and started\n`);
}

async function cmdInit(args: ParsedArgs): Promise<void> {
  const stateDir = args["state-dir"] ?? defaultStateDir();
  const hub = args.hub ?? "ws://localhost:17745";
  const force = args.force === "true";

  const configPath = join(stateDir, "config.json");
  if (existsSync(configPath) && !force) {
    process.stderr.write(
      `cc-remote init: ${configPath} already exists. Use --force to overwrite.\n`,
    );
    process.exit(2);
  }

  mkdirSync(stateDir, { recursive: true, mode: 0o700 });

  const home = homedir();
  // Sane defaults: enable allow_kill / allow_start, scope cwd to $HOME, and
  // bake a working spawn_command that pairs with the mcp-config.json the
  // daemon writes idempotently into <state_dir> on startup.
  //
  // claude path resolution: systemd/launchd run with a stripped PATH that does
  // NOT include ~/.local/bin, ~/.bun/bin etc., so a bare `claude` token would
  // hit "command not found" the first time the user creates a session via the
  // PWA. Resolve it via a login shell now (when a human is on the keyboard)
  // and bake the absolute path into config.json. Falls back to bare `claude`
  // with a warning so non-resolvable installs still produce a usable file.
  const mcpConfigPath = join(stateDir, "mcp-config.json");
  const { resolveBinaryViaLoginShell } = await import("../src/login-shell.ts");
  const claudeAbs = resolveBinaryViaLoginShell("claude");
  const claudeToken = claudeAbs ?? "claude";
  if (!claudeAbs) {
    process.stderr.write(
      `cc-remote init: warning — could not resolve 'claude' via login shell.\n` +
      `  spawn_command will use bare 'claude'; if PWA-spawned sessions die\n` +
      `  immediately, install claude or edit ${configPath} with the absolute path.\n`,
    );
  }
  const spawnCommand = `${claudeToken} --mcp-config ${mcpConfigPath} --dangerously-load-development-channels server:cc-remote`;
  const cfg = {
    daemon_id: hostname(),
    hub_url: hub,
    allow_kill: true,
    allow_start: true,
    allowed_cwd_prefix: [home],
    spawn_command: spawnCommand,
    idle_window_ms: 3000,
  };

  // Atomic write: tmp + rename.
  const tmp = `${configPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n");
  try { chmodSync(tmp, 0o600); } catch {}
  const fs = await import("node:fs");
  fs.renameSync(tmp, configPath);

  process.stdout.write(`✔ wrote ${configPath}\n`);
  process.stdout.write(`  daemon_id:           ${cfg.daemon_id}\n`);
  process.stdout.write(`  hub_url:             ${cfg.hub_url}\n`);
  process.stdout.write(`  allowed_cwd_prefix:  ${JSON.stringify(cfg.allowed_cwd_prefix)}\n`);
  process.stdout.write(`  spawn_command:       ${cfg.spawn_command}\n`);
  process.stdout.write(`\nnext steps:\n`);
  process.stdout.write(`  1. cc-remote pair --hub ${hub} --code <code-from-pwa>\n`);
  process.stdout.write(`  2. cc-remote daemon\n`);
  process.stdout.write(`\n(if 'claude' isn't on PATH, edit spawn_command in ${configPath})\n`);
}

async function cmdStatus(): Promise<void> {
  const { existsSync, readFileSync } = await import("node:fs");
  const { loadConfig } = await import("../src/config.ts");

  const cfg = loadConfig();

  process.stdout.write("=== cc-remote status ===\n\n");
  process.stdout.write(`daemon_id:           ${cfg.daemon_id}\n`);
  process.stdout.write(`hub_url:             ${cfg.hub_url}\n`);
  process.stdout.write(`state_dir:           ${cfg.state_dir}\n`);
  process.stdout.write(`allow_kill:          ${cfg.allow_kill}\n`);
  process.stdout.write(`allow_start:         ${cfg.allow_start}\n`);
  if (cfg.allow_start) {
    process.stdout.write(`allowed_cwd_prefix:  ${JSON.stringify(cfg.allowed_cwd_prefix)}\n`);
    process.stdout.write(`spawn_command:       ${cfg.spawn_command ?? "(unset — start_session will be rejected)"}\n`);
  }
  process.stdout.write(`idle_window_ms:      ${cfg.idle_window_ms}\n`);
  process.stdout.write("\n");

  // Pairing status
  if (existsSync(cfg.state_path)) {
    try {
      const state = JSON.parse(readFileSync(cfg.state_path, "utf8")) as { jwt?: string; exp?: number; paired_at?: number };
      process.stdout.write(`paired:              yes\n`);
      if (state.exp) {
        const expIso = new Date(state.exp * 1000).toISOString();
        const remaining = Math.round((state.exp * 1000 - Date.now()) / 1000);
        process.stdout.write(`jwt_exp:             ${expIso} (${remaining}s remaining)\n`);
      }
      if (state.paired_at) {
        process.stdout.write(`paired_at:           ${new Date(state.paired_at).toISOString()}\n`);
      }
    } catch (e) {
      process.stdout.write(`paired:              CORRUPT (${(e as Error).message})\n`);
    }
  } else {
    process.stdout.write(`paired:              no — run 'cc-remote pair --hub <url> --code <code>'\n`);
  }
  process.stdout.write("\n");

  // Permission audit
  const dbPath = `${cfg.state_dir}/db.sqlite`;
  if (existsSync(dbPath)) {
    try {
      const { Database } = await import("bun:sqlite");
      const db = new Database(dbPath, { readonly: true });
      try {
        const total = db.query("SELECT count(*) AS n FROM permissions").get() as { n: number };
        process.stdout.write(`permissions logged:  ${total.n}\n`);
        const recent = db.query(
          "SELECT request_id, tool, args_summary, decision, decided_via, created_at, resolved_at FROM permissions ORDER BY created_at DESC LIMIT 5"
        ).all() as Array<{
          request_id: string; tool: string; args_summary: string;
          decision: string | null; decided_via: string | null;
          created_at: number; resolved_at: number | null;
        }>;
        if (recent.length > 0) {
          process.stdout.write(`\nrecent permissions:\n`);
          for (const r of recent) {
            const age = Math.round((Date.now() - r.created_at) / 1000);
            const status = r.decision ? `${r.decision} via ${r.decided_via ?? "?"}` : "PENDING";
            process.stdout.write(`  ${age.toString().padStart(6)}s ago  ${r.tool.padEnd(8)} ${status.padEnd(20)} ${r.args_summary.slice(0, 60)}\n`);
          }
        }
      } finally { db.close(); }
    } catch (e) {
      process.stdout.write(`permissions:         could not read (${(e as Error).message})\n`);
    }
  } else {
    process.stdout.write(`permissions:         no audit DB yet\n`);
  }
}

async function cmdUninstall(args: ParsedArgs): Promise<void> {
  const { detectPlatform, unitPath, uninstallCommands } = await import("../src/installer.ts");
  const platform = detectPlatform();
  if (platform === "unsupported") {
    throw new Error(`unsupported platform: ${process.platform}`);
  }
  const dry = args["dry-run"] === "true";
  const path = unitPath(platform);
  const cmds = uninstallCommands(platform, path);

  process.stdout.write(`platform:  ${platform}\n`);
  process.stdout.write(`unit file: ${path}\n`);

  if (dry) {
    if (cmds.stop.length) process.stdout.write(`would run: ${cmds.stop.join(" ")}\n`);
    if (cmds.disable.length) process.stdout.write(`would run: ${cmds.disable.join(" ")}\n`);
    if (cmds.remove_file) process.stdout.write(`would remove: ${path}\n`);
    return;
  }

  for (const argv of [cmds.stop, cmds.disable]) {
    if (argv.length === 0) continue;
    spawnSync(argv[0]!, argv.slice(1), { stdio: "inherit" }); // tolerate non-zero (already stopped/disabled)
  }
  if (cmds.remove_file && existsSync(path)) {
    try { unlinkSync(path); process.stdout.write(`✔ removed ${path}\n`); } catch (e) {
      process.stderr.write(`warn: could not remove ${path}: ${(e as Error).message}\n`);
    }
  }
  process.stdout.write(`✔ daemon uninstalled\n`);
}

function usage(): string {
  return [
    "usage: cc-remote <command> [options]",
    "",
    "commands:",
    "  init [--state-dir <path>] [--hub <url>] [--force]",
    "                               write a starter config.json (no pair)",
    "  daemon                       run the long-lived daemon",
    "  daemon rotate-token          rotate the DPoP-bound JWT",
    "  pair --hub <url> --code <c>  bind this machine to the hub",
    "    [--daemon-id <id>]         override default (hostname)",
    "  install [--dry-run] [--no-path-env]",
    "                               install daemon as launchd/systemd unit",
    "  uninstall [--dry-run]        remove the unit",
    "  status                       show pairing/permission/health state",
  ].join("\n");
}

const cmd = process.argv[2];
const sub = process.argv[3];
const args = parseArgs(process.argv.slice(sub && !sub.startsWith("--") ? 4 : 3));

try {
  if (cmd === "init") await cmdInit(args);
  else if (cmd === "pair") await cmdPair(args);
  else if (cmd === "daemon" && sub === "rotate-token") await cmdDaemonRotateToken();
  else if (cmd === "daemon") await cmdDaemon();
  else if (cmd === "install") await cmdInstall(args);
  else if (cmd === "uninstall") await cmdUninstall(args);
  else if (cmd === "status") await cmdStatus();
  else {
    process.stderr.write(usage() + "\n");
    process.exit(1);
  }
} catch (e) {
  process.stderr.write(`cc-remote: ${(e as Error).message}\n`);
  process.exit(1);
}
