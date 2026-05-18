import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHistory } from "../src/jsonl-history.ts";

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "ccr-h-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("returns the last N lines whose end-offset <= before_offset", async () => {
  const t = tmp();
  try {
    const path = join(t.dir, "s.jsonl");
    const lines = [
      JSON.stringify({ i: 1 }),
      JSON.stringify({ i: 2 }),
      JSON.stringify({ i: 3 }),
      JSON.stringify({ i: 4 }),
      JSON.stringify({ i: 5 }),
    ];
    writeFileSync(path, lines.join("\n") + "\n");
    const totalSize = (await Bun.file(path).arrayBuffer()).byteLength;

    const history = await readHistory(path, totalSize, 3);
    expect(history.length).toBe(3);
    expect((history[0]!.payload as { i: number }).i).toBe(3);
    expect((history[1]!.payload as { i: number }).i).toBe(4);
    expect((history[2]!.payload as { i: number }).i).toBe(5);
  } finally { t.cleanup(); }
});

test("respects before_offset (returns lines before the cut)", async () => {
  const t = tmp();
  try {
    const path = join(t.dir, "s.jsonl");
    const lines = ["{\"i\":1}", "{\"i\":2}", "{\"i\":3}"];
    writeFileSync(path, lines.join("\n") + "\n");
    // Cut after line 2: byte offset = len("{\"i\":1}\n{\"i\":2}\n")
    const cut = (lines[0]!.length + 1) + (lines[1]!.length + 1); // 8 + 8 = 16

    const history = await readHistory(path, cut, 10);
    expect(history.length).toBe(2);
    expect((history[0]!.payload as { i: number }).i).toBe(1);
    expect((history[1]!.payload as { i: number }).i).toBe(2);
  } finally { t.cleanup(); }
});

test("returns empty array when file does not exist", async () => {
  const t = tmp();
  try {
    const history = await readHistory(join(t.dir, "missing.jsonl"), 1000, 5);
    expect(history).toEqual([]);
  } finally { t.cleanup(); }
});

test("returns empty array when before_offset is 0", async () => {
  const t = tmp();
  try {
    const path = join(t.dir, "s.jsonl");
    writeFileSync(path, "{\"i\":1}\n{\"i\":2}\n");
    const history = await readHistory(path, 0, 5);
    expect(history).toEqual([]);
  } finally { t.cleanup(); }
});

test("returns fewer than limit when file is smaller", async () => {
  const t = tmp();
  try {
    const path = join(t.dir, "s.jsonl");
    writeFileSync(path, "{\"a\":1}\n{\"b\":2}\n");
    const totalSize = (await Bun.file(path).arrayBuffer()).byteLength;
    const history = await readHistory(path, totalSize, 100);
    expect(history.length).toBe(2);
  } finally { t.cleanup(); }
});

test("malformed JSON line is wrapped as { raw }", async () => {
  const t = tmp();
  try {
    const path = join(t.dir, "s.jsonl");
    writeFileSync(path, "not json\n{\"ok\":true}\n");
    const totalSize = (await Bun.file(path).arrayBuffer()).byteLength;
    const history = await readHistory(path, totalSize, 10);
    expect(history.length).toBe(2);
    expect(history[0]!.payload).toEqual({ raw: "not json" });
    expect((history[1]!.payload as { ok: boolean }).ok).toBe(true);
  } finally { t.cleanup(); }
});
