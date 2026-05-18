import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWatcher } from "../src/jsonl-watcher.ts";

async function waitFor<T>(pred: () => T | null, timeoutMs: number): Promise<T> {
  const start = Date.now();
  while (true) {
    const r = pred();
    if (r) return r;
    if (Date.now() - start > timeoutMs) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 25));
  }
}

test("emits a line appended after watcher starts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-w-"));
  const path = join(dir, "test.jsonl");
  writeFileSync(path, ""); // empty file
  const lines: Array<{ line: string; offset: number }> = [];
  const w = startWatcher({ path, onLine: (line, offset) => lines.push({ line, offset }) });
  try {
    appendFileSync(path, "hello\n");
    await waitFor(() => (lines.length === 1 ? lines : null), 2000);
    const first = lines[0]!;
    expect(first.line).toBe("hello");
    expect(first.offset).toBe(6); // "hello\n" is 6 bytes
  } finally {
    w.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("emits multiple lines in one write", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-w-"));
  const path = join(dir, "test.jsonl");
  writeFileSync(path, "");
  const lines: string[] = [];
  const w = startWatcher({ path, onLine: (line) => lines.push(line) });
  try {
    appendFileSync(path, "a\nb\nc\n");
    await waitFor(() => (lines.length === 3 ? lines : null), 2000);
    expect(lines).toEqual(["a", "b", "c"]);
  } finally {
    w.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buffers partial line until newline arrives", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-w-"));
  const path = join(dir, "test.jsonl");
  writeFileSync(path, "");
  const lines: string[] = [];
  const w = startWatcher({ path, onLine: (line) => lines.push(line) });
  try {
    appendFileSync(path, "first half ");
    await new Promise((r) => setTimeout(r, 200));
    expect(lines).toEqual([]);
    appendFileSync(path, "second half\n");
    await waitFor(() => (lines.length === 1 ? lines : null), 2000);
    expect(lines[0]).toBe("first half second half");
  } finally {
    w.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("starts at current EOF when startOffset is not given (skips pre-existing content)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-w-"));
  const path = join(dir, "test.jsonl");
  writeFileSync(path, "old line\n");  // pre-existing content
  const lines: string[] = [];
  const w = startWatcher({ path, onLine: (line) => lines.push(line) });
  try {
    await new Promise((r) => setTimeout(r, 100));
    expect(lines).toEqual([]); // pre-existing line not emitted
    appendFileSync(path, "new line\n");
    await waitFor(() => (lines.length === 1 ? lines : null), 2000);
    expect(lines[0]).toBe("new line");
  } finally {
    w.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startOffset=0 emits all existing content", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-w-"));
  const path = join(dir, "test.jsonl");
  writeFileSync(path, "a\nb\n");
  const lines: string[] = [];
  const w = startWatcher({ path, startOffset: 0, onLine: (line) => lines.push(line) });
  try {
    await waitFor(() => (lines.length === 2 ? lines : null), 2000);
    expect(lines).toEqual(["a", "b"]);
  } finally {
    w.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("works when file does not exist yet (waits for creation)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-w-"));
  const path = join(dir, "later.jsonl");
  const lines: string[] = [];
  const w = startWatcher({ path, onLine: (line) => lines.push(line) });
  try {
    await new Promise((r) => setTimeout(r, 100));
    writeFileSync(path, "delayed\n");
    await waitFor(() => (lines.length === 1 ? lines : null), 2000);
    expect(lines[0]).toBe("delayed");
  } finally {
    w.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
