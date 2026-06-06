import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  probeAgent,
  clearProbeCacheForTests,
  cmpVersion,
  type SpawnFn,
} from "../src/agent-probe.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "agent-probe-"));
}

function fakeSpawn(scripts: Record<string, { code: number; stdout: string }>): SpawnFn & { count: number } {
  const fn = ((cmd: string[]) => {
    fn.count += 1;
    const key = cmd.join(" ");
    const script = scripts[key];
    if (!script) {
      return {
        exited: Promise.resolve(127),
        stdout: streamFromString(""),
      };
    }
    return {
      exited: Promise.resolve(script.code),
      stdout: streamFromString(script.stdout),
    };
  }) as SpawnFn & { count: number };
  fn.count = 0;
  return fn;
}

function streamFromString(s: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(s);
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
}

const HEALTHY_HELP = `\
Usage: claude [options]

Options:
  --permission-mode <mode>  permission mode (choices: ["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"])
  --model <name>            model alias
`;

beforeEach(() => {
  clearProbeCacheForTests();
});

test("healthy --help + --version produces parsed modes and version-gated bits", async () => {
  const home = tmp();
  const cwd = tmp();
  try {
    const spawn = fakeSpawn({
      "claude --version": { code: 0, stdout: "2.1.150 (Claude Code)\n" },
      "claude --help": { code: 0, stdout: HEALTHY_HELP },
    });
    const r = await probeAgent({ homeDir: home, cwd, spawn });
    expect(r.agent_version).toBe("2.1.150");
    expect(r.available_modes).toEqual([
      "acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan",
    ]);
    expect(r.default_mode).toBeNull();
    expect(r.available_models).toEqual(["sonnet", "opus", "haiku"]);
    expect(r.capabilities.supports_notification_hook).toBe(true);
    expect(r.capabilities.supports_ack).toBe(true);
    expect(r.capabilities.jsonl_flush_quirk).toBe(true);
    expect(r.capabilities.has_mcp).toBe(true);
    expect(r.capabilities.has_plugin).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("--version exit 1 yields agent_version null and version-gated bits false", async () => {
  const home = tmp();
  const cwd = tmp();
  try {
    const spawn = fakeSpawn({
      "claude --version": { code: 1, stdout: "" },
      "claude --help": { code: 0, stdout: HEALTHY_HELP },
    });
    const r = await probeAgent({ homeDir: home, cwd, spawn });
    expect(r.agent_version).toBeNull();
    expect(r.capabilities.supports_notification_hook).toBe(false);
    expect(r.capabilities.supports_ack).toBe(false);
    expect(r.capabilities.jsonl_flush_quirk).toBe(false);
    // Daemon-side bits stay true regardless.
    expect(r.capabilities.has_mcp).toBe(true);
    expect(r.capabilities.has_plugin).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("--help missing the choices block falls back to hardcoded modes", async () => {
  const home = tmp();
  const cwd = tmp();
  try {
    const spawn = fakeSpawn({
      "claude --version": { code: 0, stdout: "2.1.165\n" },
      "claude --help": { code: 0, stdout: "Usage: claude [opts]\n  --version\n  --help\n" },
    });
    const r = await probeAgent({ homeDir: home, cwd, spawn });
    expect(r.available_modes).toEqual([
      "acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan",
    ]);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("missing settings.json everywhere yields default_mode null", async () => {
  const home = tmp();
  const cwd = tmp();
  try {
    const spawn = fakeSpawn({
      "claude --version": { code: 0, stdout: "2.1.165\n" },
      "claude --help": { code: 0, stdout: HEALTHY_HELP },
    });
    const r = await probeAgent({ homeDir: home, cwd, spawn });
    expect(r.default_mode).toBeNull();
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("project settings.json overrides user settings.json for default_mode", async () => {
  const home = tmp();
  const cwd = tmp();
  try {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ permissions: { defaultMode: "default" } }),
    );
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(
      join(cwd, ".claude", "settings.json"),
      JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }),
    );

    const spawn = fakeSpawn({
      "claude --version": { code: 0, stdout: "2.1.165\n" },
      "claude --help": { code: 0, stdout: HEALTHY_HELP },
    });
    const r = await probeAgent({ homeDir: home, cwd, spawn });
    expect(r.default_mode).toBe("bypassPermissions");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("only user settings present yields the user defaultMode", async () => {
  const home = tmp();
  const cwd = tmp();
  try {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ permissions: { defaultMode: "auto" } }),
    );

    const spawn = fakeSpawn({
      "claude --version": { code: 0, stdout: "2.1.165\n" },
      "claude --help": { code: 0, stdout: HEALTHY_HELP },
    });
    const r = await probeAgent({ homeDir: home, cwd, spawn });
    expect(r.default_mode).toBe("auto");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("malformed project settings.json falls through to user file", async () => {
  const home = tmp();
  const cwd = tmp();
  try {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ permissions: { defaultMode: "plan" } }),
    );
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(join(cwd, ".claude", "settings.json"), "{ this is not json");

    const spawn = fakeSpawn({
      "claude --version": { code: 0, stdout: "2.1.165\n" },
      "claude --help": { code: 0, stdout: HEALTHY_HELP },
    });
    const r = await probeAgent({ homeDir: home, cwd, spawn });
    expect(r.default_mode).toBe("plan");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("two concurrent probes share one CLI spawn round (cache)", async () => {
  const home = tmp();
  const cwd = tmp();
  try {
    const spawn = fakeSpawn({
      "claude --version": { code: 0, stdout: "2.1.165\n" },
      "claude --help": { code: 0, stdout: HEALTHY_HELP },
    });
    const [a, b] = await Promise.all([
      probeAgent({ homeDir: home, cwd, spawn }),
      probeAgent({ homeDir: home, cwd, spawn }),
    ]);
    expect(a.agent_version).toBe("2.1.165");
    expect(b.agent_version).toBe("2.1.165");
    // Two spawns total: one --version and one --help, shared by both callers.
    expect(spawn.count).toBe(2);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("cmpVersion handles common cases", () => {
  expect(cmpVersion("2.1.150", "2.1.146")).toBe(1);
  expect(cmpVersion("2.1.146", "2.1.146")).toBe(0);
  expect(cmpVersion("2.1.139", "2.1.146")).toBe(-1);
  expect(cmpVersion("2.1.150", "2.1.150")).toBe(0);
  expect(cmpVersion("3.0.0", "2.99.99")).toBe(1);
  expect(cmpVersion("2.1", "2.1.0")).toBe(0);
});

test("version 2.1.139 enables jsonl_flush_quirk but not ack/notification", async () => {
  const home = tmp();
  const cwd = tmp();
  try {
    const spawn = fakeSpawn({
      "claude --version": { code: 0, stdout: "2.1.139\n" },
      "claude --help": { code: 0, stdout: HEALTHY_HELP },
    });
    const r = await probeAgent({ homeDir: home, cwd, spawn });
    expect(r.capabilities.jsonl_flush_quirk).toBe(true);
    expect(r.capabilities.supports_notification_hook).toBe(false);
    expect(r.capabilities.supports_ack).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
