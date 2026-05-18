#!/usr/bin/env bun
import { hostname } from "node:os";
import { writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
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

function usage(): string {
  return [
    "usage: cc-remote <command> [options]",
    "",
    "commands:",
    "  daemon                       run the long-lived daemon",
    "  pair --hub <url> --code <c>  bind this machine to the hub",
    "    [--daemon-id <id>]         override default (hostname)",
  ].join("\n");
}

const cmd = process.argv[2];
const args = parseArgs(process.argv.slice(3));

try {
  if (cmd === "pair") await cmdPair(args);
  else if (cmd === "daemon") await cmdDaemon();
  else {
    process.stderr.write(usage() + "\n");
    process.exit(1);
  }
} catch (e) {
  process.stderr.write(`cc-remote: ${(e as Error).message}\n`);
  process.exit(1);
}
