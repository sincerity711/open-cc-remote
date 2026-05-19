import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindJsonl } from "../src/jsonl-bind.ts";

test("bindJsonl resolves with the first new .jsonl file's basename", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-bind-"));
  try {
    const expected = "11111111-1111-1111-1111-111111111111";
    const filePath = join(dir, `${expected}.jsonl`);
    setTimeout(() => writeFileSync(filePath, "{}\n"), 50);
    const claudeId = await bindJsonl({ dir, registerTimeMs: Date.now() - 100, timeoutMs: 2000 });
    expect(claudeId).toBe(expected);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("bindJsonl resolves null on timeout with no new file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-bind-to-"));
  try {
    const claudeId = await bindJsonl({ dir, registerTimeMs: Date.now(), timeoutMs: 200 });
    expect(claudeId).toBeNull();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("bindJsonl ignores non-jsonl files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-bind-other-"));
  try {
    const expected = "22222222-2222-2222-2222-222222222222";
    setTimeout(() => writeFileSync(join(dir, "not-a-session.txt"), "x"), 30);
    setTimeout(() => writeFileSync(join(dir, `${expected}.jsonl`), "{}\n"), 80);
    const claudeId = await bindJsonl({ dir, registerTimeMs: Date.now() - 100, timeoutMs: 2000 });
    expect(claudeId).toBe(expected);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
