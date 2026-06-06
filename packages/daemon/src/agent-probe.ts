// Probe the local `claude` binary for capabilities the daemon needs to advertise
// to the PWA: version, available permission modes, default mode, plus version-
// gated capability bits. See docs/superpowers/specs/2026-06-07-agent-handshake-design.md.
//
// The CLI-derived bits (version, modes, capabilities) are cached at module
// scope via a single in-flight Promise so concurrent boots don't double-spawn.
// The settings.json read is per-call (cheap) so a session in a different cwd
// picks up its project-level `permissions.defaultMode`.

import { readFile as nodeReadFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentCapabilityBits } from "@cc-remote/proto";

export interface AgentProbeResult {
  agent_version: string | null;
  available_modes: string[];
  default_mode: string | null;
  available_models: string[];
  capabilities: AgentCapabilityBits;
}

interface CliProbeResult {
  agent_version: string | null;
  available_modes: string[];
  capabilities: AgentCapabilityBits;
}

// Test-only seam: signature compatible with Bun.spawn for the two short-lived
// commands we run. We deliberately type only what we use to avoid coupling to
// Bun-specific subprocess types in tests.
export type SpawnFn = (cmd: string[], opts?: { stdout?: "pipe"; stderr?: "pipe" }) => {
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array> | null;
};

export type ReadFn = typeof nodeReadFile;

const HARDCODED_MODES = [
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "default",
  "dontAsk",
  "plan",
];

const HARDCODED_MODELS = ["sonnet", "opus", "haiku"];

let cliCached: Promise<CliProbeResult> | null = null;

export function clearProbeCacheForTests(): void {
  cliCached = null;
}

export interface ProbeOptions {
  homeDir: string;
  cwd: string;
  /** Override for tests; defaults to a thin wrapper around Bun.spawn. */
  spawn?: SpawnFn;
  /** Override for tests; defaults to node:fs/promises#readFile. */
  readFile?: ReadFn;
}

export async function probeAgent(opts: ProbeOptions): Promise<AgentProbeResult> {
  const cli = await getOrProbeCli(opts.spawn);
  const default_mode = await readDefaultMode(opts.homeDir, opts.cwd, opts.readFile ?? nodeReadFile);
  return {
    agent_version: cli.agent_version,
    available_modes: cli.available_modes,
    default_mode,
    available_models: HARDCODED_MODELS.slice(),
    capabilities: cli.capabilities,
  };
}

function getOrProbeCli(spawn?: SpawnFn): Promise<CliProbeResult> {
  if (cliCached) return cliCached;
  cliCached = probeCli(spawn ?? defaultSpawn);
  return cliCached;
}

async function probeCli(spawn: SpawnFn): Promise<CliProbeResult> {
  const [version, helpModes] = await Promise.all([
    runVersion(spawn),
    runHelpModes(spawn),
  ]);
  return {
    agent_version: version,
    available_modes: helpModes,
    capabilities: capabilitiesFor(version),
  };
}

async function runVersion(spawn: SpawnFn): Promise<string | null> {
  try {
    const proc = spawn(["claude", "--version"], { stdout: "pipe", stderr: "pipe" });
    const text = await readWithTimeout(proc, 2000);
    if (text === null) return null;
    const m = text.match(/(\d+\.\d+\.\d+(?:\.\d+)?)/);
    return m ? m[1]! : null;
  } catch (e) {
    process.stderr.write(`agent-probe: --version failed: ${(e as Error).message}\n`);
    return null;
  }
}

async function runHelpModes(spawn: SpawnFn): Promise<string[]> {
  try {
    const proc = spawn(["claude", "--help"], { stdout: "pipe", stderr: "pipe" });
    const text = await readWithTimeout(proc, 2000);
    if (text === null) return HARDCODED_MODES.slice();
    // The help line looks like:
    //   --permission-mode <mode>  ... choices: ["acceptEdits", "auto", ...]
    // We tolerate "choice" / "choices" and either single or double quotes.
    const m = text.match(/--permission-mode[\s\S]*?choices?\s*:\s*\[([^\]]+)\]/);
    if (!m) {
      process.stderr.write("agent-probe: could not parse --permission-mode choices, using fallback list\n");
      return HARDCODED_MODES.slice();
    }
    const modes = m[1]!
      .split(",")
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
      .filter((s) => s.length > 0);
    return modes.length > 0 ? modes : HARDCODED_MODES.slice();
  } catch (e) {
    process.stderr.write(`agent-probe: --help failed: ${(e as Error).message}\n`);
    return HARDCODED_MODES.slice();
  }
}

async function readWithTimeout(
  proc: { exited: Promise<number>; stdout: ReadableStream<Uint8Array> | null },
  timeoutMs: number,
): Promise<string | null> {
  if (!proc.stdout) return null;
  const reader = proc.stdout.getReader();
  const chunks: Uint8Array[] = [];
  const timer = new Promise<"timeout">((resolve) =>
    setTimeout(() => resolve("timeout"), timeoutMs),
  );
  while (true) {
    const next = reader.read();
    const winner = await Promise.race([next, timer]);
    if (winner === "timeout") {
      try { reader.cancel().catch(() => {}); } catch {}
      return null;
    }
    const { value, done } = winner;
    if (done) break;
    if (value) chunks.push(value);
  }
  const code = await proc.exited;
  if (code !== 0) return null;
  return new TextDecoder().decode(concatChunks(chunks));
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

const defaultSpawn: SpawnFn = (cmd, opts) => {
  // Bun.spawn returns an object with `.exited` and `.stdout` as a
  // ReadableStream when stdout is "pipe".
  const proc = Bun.spawn(cmd, opts as Parameters<typeof Bun.spawn>[1]);
  return {
    exited: proc.exited,
    stdout: proc.stdout as ReadableStream<Uint8Array> | null,
  };
};

// ─── settings.json ────────────────────────────────────────────────────

async function readDefaultMode(homeDir: string, cwd: string, read: ReadFn): Promise<string | null> {
  const project = await readSettingsMode(join(cwd, ".claude", "settings.json"), read);
  if (project !== undefined) return project;
  const user = await readSettingsMode(join(homeDir, ".claude", "settings.json"), read);
  if (user !== undefined) return user;
  return null;
}

/**
 * Returns:
 *   `string` — defaultMode value present
 *   `null`   — file present but no defaultMode key
 *   `undefined` — file absent OR JSON unparseable (caller falls through)
 *
 * On JSON parse error we emit a stderr warning. ENOENT is silent.
 */
async function readSettingsMode(path: string, read: ReadFn): Promise<string | null | undefined> {
  let raw: string;
  try {
    raw = await read(path, "utf8") as string;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      process.stderr.write(`agent-probe: read ${path} failed: ${(e as Error).message}\n`);
    }
    return undefined;
  }
  try {
    const obj = JSON.parse(raw) as { permissions?: { defaultMode?: string } };
    const m = obj?.permissions?.defaultMode;
    return typeof m === "string" ? m : null;
  } catch (e) {
    process.stderr.write(`agent-probe: parse ${path} failed: ${(e as Error).message}\n`);
    return undefined;
  }
}

// ─── version comparison ───────────────────────────────────────────────

export function cmpVersion(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split(".").map((s) => parseInt(s, 10) || 0);
  const pb = b.split(".").map((s) => parseInt(s, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const ai = pa[i] ?? 0;
    const bi = pb[i] ?? 0;
    if (ai < bi) return -1;
    if (ai > bi) return 1;
  }
  return 0;
}

function gte(a: string | null, b: string): boolean {
  if (!a) return false;
  return cmpVersion(a, b) >= 0;
}

function capabilitiesFor(version: string | null): AgentCapabilityBits {
  return {
    supports_notification_hook: gte(version, "2.1.146"),
    supports_ack: gte(version, "2.1.150"),
    jsonl_flush_quirk: gte(version, "2.1.139"),
    // Daemon-side features that don't depend on the binary version.
    has_mcp: true,
    has_plugin: true,
  };
}
