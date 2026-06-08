import { test, expect } from "bun:test";
import type { spawnSync as SpawnSync } from "node:child_process";
import {
  resolveBinaryViaLoginShell,
  loginShellPath,
  runInLoginShell,
} from "../src/login-shell.ts";

type SpawnSyncReturn = ReturnType<typeof SpawnSync>;
type FakeShell = (shell: string, args: readonly string[]) => Partial<SpawnSyncReturn>;

function makeSpawn(impl: FakeShell): typeof SpawnSync {
  return ((cmd: string, args?: readonly string[]) => {
    const r = impl(cmd, args ?? []);
    return {
      pid: 0,
      output: [null, r.stdout ?? "", r.stderr ?? ""],
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      status: r.status ?? 0,
      signal: null,
      ...r,
    } as unknown as SpawnSyncReturn;
  }) as unknown as typeof SpawnSync;
}

test("resolveBinaryViaLoginShell returns the absolute path bash prints", () => {
  const spawn = makeSpawn((shell, args) => {
    expect(shell).toBe("bash");
    expect(args).toEqual(["-lc", "command -v claude"]);
    return { stdout: "/home/u/.local/bin/claude\n", status: 0 };
  });
  expect(resolveBinaryViaLoginShell("claude", spawn)).toBe("/home/u/.local/bin/claude");
});

test("resolveBinaryViaLoginShell falls back to zsh when bash fails", () => {
  const calls: string[] = [];
  const spawn = makeSpawn((shell) => {
    calls.push(shell);
    if (shell === "bash") return { status: 127, stderr: "bash: not found" };
    if (shell === "zsh") return { stdout: "/opt/homebrew/bin/claude\n", status: 0 };
    return { status: 1 };
  });
  expect(resolveBinaryViaLoginShell("claude", spawn)).toBe("/opt/homebrew/bin/claude");
  expect(calls).toEqual(["bash", "zsh"]);
});

test("resolveBinaryViaLoginShell returns null when no shell finds the binary", () => {
  const spawn = makeSpawn(() => ({ status: 1 }));
  expect(resolveBinaryViaLoginShell("claude", spawn)).toBeNull();
});

test("resolveBinaryViaLoginShell rejects non-absolute output (builtin/alias case)", () => {
  // command -v can echo `alias claude='claude --foo'` which we shouldn't
  // bake into spawn_command.
  const spawn = makeSpawn(() => ({ stdout: "alias claude='claude --foo'\n", status: 0 }));
  expect(resolveBinaryViaLoginShell("claude", spawn)).toBeNull();
});

test("resolveBinaryViaLoginShell rejects suspicious binary names without invoking shell", () => {
  let invoked = false;
  const spawn = makeSpawn(() => { invoked = true; return { status: 0 }; });
  expect(resolveBinaryViaLoginShell("claude; rm -rf /", spawn)).toBeNull();
  expect(invoked).toBe(false);
});

test("loginShellPath returns the trimmed PATH bash prints", () => {
  const spawn = makeSpawn((shell, args) => {
    expect(shell).toBe("bash");
    expect(args).toEqual(["-lc", `printf %s "$PATH"`]);
    return { stdout: "/home/u/.local/bin:/usr/bin:/bin", status: 0 };
  });
  expect(loginShellPath(spawn)).toBe("/home/u/.local/bin:/usr/bin:/bin");
});

test("loginShellPath returns null when no login shell answers", () => {
  const spawn = makeSpawn(() => ({ status: 1 }));
  expect(loginShellPath(spawn)).toBeNull();
});

test("runInLoginShell skips shells that error out, returns first non-empty result", () => {
  const spawn = makeSpawn((shell) => {
    if (shell === "bash") return { stdout: "  ", status: 0 };  // empty after trim
    if (shell === "zsh") return { stdout: "ok\n", status: 0 };
    return { status: 1 };
  });
  expect(runInLoginShell("echo ok", spawn)).toEqual({ shell: "zsh", output: "ok" });
});
