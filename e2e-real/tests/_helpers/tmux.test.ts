// Self-test for helpers/tmux.ts. Skipped if tmux isn't on PATH.
import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  newSession, sendKeys, capturePane, hasSession, killSession, waitForPattern,
} from "../../helpers/tmux.ts";

const tmuxAvailable = spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0;

test.if(tmuxAvailable)("tmux primitives: newSession + sendKeys + waitForPattern + killSession", async () => {
  const name = `ccr-tmuxtest-${Date.now()}`;
  newSession(name, "/tmp");
  try {
    sendKeys(name, "echo hello-tmux-helper", true);
    const cap = await waitForPattern(name, /hello-tmux-helper/, 5_000, "echo output");
    expect(cap).toContain("hello-tmux-helper");
    expect(hasSession(name)).toBe(true);
  } finally {
    killSession(name);
    expect(hasSession(name)).toBe(false);
  }
});

if (!tmuxAvailable) {
  test.skip("tmux primitives: tmux not on PATH; skipping", () => {});
}
