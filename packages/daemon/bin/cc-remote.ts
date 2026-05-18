#!/usr/bin/env bun
import { hostname } from "node:os";
import { existsSync, mkdirSync, writeFileSync, unlinkSync, chmodSync } from "node:fs";
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
  writeFileSync(configPath, JSON.stringify({ daemon_id, hub_url: hub }, null, 2) + "\n");
  try { chmodSync(configPath, 0o600); } catch {}

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
  const content = unitContent(platform, {
    bun_path: bunPath,
    cc_remote_bin: ccRemoteBin,
    state_dir: stateDir,
  });
  const cmds = installCommands(platform, path);

  process.stdout.write(`platform:        ${platform}\n`);
  process.stdout.write(`unit file:       ${path}\n`);
  process.stdout.write(`state dir:       ${stateDir}\n`);
  process.stdout.write(`bun:             ${bunPath}\n`);
  process.stdout.write(`cc-remote bin:   ${ccRemoteBin}\n`);
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
    "  daemon                       run the long-lived daemon",
    "  daemon rotate-token          rotate the DPoP-bound JWT",
    "  pair --hub <url> --code <c>  bind this machine to the hub",
    "    [--daemon-id <id>]         override default (hostname)",
    "  install [--dry-run]          install daemon as launchd/systemd unit",
    "  uninstall [--dry-run]        remove the unit",
  ].join("\n");
}

const cmd = process.argv[2];
const sub = process.argv[3];
const args = parseArgs(process.argv.slice(sub && !sub.startsWith("--") ? 4 : 3));

try {
  if (cmd === "pair") await cmdPair(args);
  else if (cmd === "daemon" && sub === "rotate-token") await cmdDaemonRotateToken();
  else if (cmd === "daemon") await cmdDaemon();
  else if (cmd === "install") await cmdInstall(args);
  else if (cmd === "uninstall") await cmdUninstall(args);
  else {
    process.stderr.write(usage() + "\n");
    process.exit(1);
  }
} catch (e) {
  process.stderr.write(`cc-remote: ${(e as Error).message}\n`);
  process.exit(1);
}
