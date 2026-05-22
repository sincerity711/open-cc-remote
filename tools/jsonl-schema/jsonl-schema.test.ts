import { test, expect } from "bun:test";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { validateClaudeJsonlLine } from "./index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const fixturesDir = join(repoRoot, "e2e-real", "fixtures", "jsonl-tapes");

function parseLines(text: string): unknown[] {
  return text
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

test("every fixture line in e2e-real/fixtures/jsonl-tapes validates", () => {
  const files = readdirSync(fixturesDir).filter((f) => f.endsWith(".jsonl"));
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const path = join(fixturesDir, file);
    const text = readFileSync(path, "utf8");
    const lines = parseLines(text);
    expect(lines.length).toBeGreaterThan(0);
    lines.forEach((obj, idx) => {
      const r = validateClaudeJsonlLine(obj);
      if (!r.ok) {
        throw new Error(`${file} line ${idx + 1}: ${r.error}\n${JSON.stringify(obj).slice(0, 400)}`);
      }
    });
  }
});

// "Drift detector" — when a real CC sample is available locally, validate
// every line. The error message includes the sample's path + the offending
// line so a human can patch fixtures + validator. CI without local CC skips.
test("drift detector: real CC session (if available)", () => {
  const candidates = realCcSampleCandidates();
  let chosen: string | null = null;
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    if (files.length > 0 && files[0]) {
      chosen = join(dir, files[0].f);
      break;
    }
  }
  if (!chosen) {
    console.log("[skip] no real CC sample available (looked in ~/.claude/projects/)");
    return;
  }

  const text = readFileSync(chosen, "utf8");
  const lines = text.split("\n").filter((l) => l.length > 0);
  for (let i = 0; i < lines.length; i++) {
    let obj: unknown;
    try {
      obj = JSON.parse(lines[i]!);
    } catch {
      throw new Error(`${chosen} line ${i + 1}: invalid JSON`);
    }
    const r = validateClaudeJsonlLine(obj);
    if (!r.ok) {
      throw new Error(`${chosen} line ${i + 1}: ${r.error}\n${lines[i]!.slice(0, 400)}`);
    }
  }
  console.log(`[drift-detector] ${chosen} (${lines.length} lines) — OK`);
});

// Latest-3-by-type: for each known top-level type that appears in the real
// sample, take the LAST 3 occurrences and re-validate. This is the canonical
// "did Claude Code change its JSONL shape" check.
test("drift detector: last 3 lines of each top-level type validate", () => {
  const candidates = realCcSampleCandidates();
  let chosen: string | null = null;
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    if (files.length > 0 && files[0]) {
      chosen = join(dir, files[0].f);
      break;
    }
  }
  if (!chosen) {
    console.log("[skip] no real CC sample available");
    return;
  }

  const text = readFileSync(chosen, "utf8");
  const allLines = text.split("\n").filter((l) => l.length > 0);
  const byType = new Map<string, Array<{ idx: number; raw: string; obj: Record<string, unknown> }>>();
  for (let i = 0; i < allLines.length; i++) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(allLines[i]!) as Record<string, unknown>;
    } catch {
      continue;
    }
    const t = typeof obj["type"] === "string" ? (obj["type"] as string) : "_unknown";
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t)!.push({ idx: i + 1, raw: allLines[i]!, obj });
  }

  for (const [type, occurrences] of byType.entries()) {
    const last3 = occurrences.slice(-3);
    for (const { idx, raw, obj } of last3) {
      const r = validateClaudeJsonlLine(obj);
      if (!r.ok) {
        throw new Error(
          `${chosen} type=${type} line ${idx}: ${r.error}\n${raw.slice(0, 400)}`,
        );
      }
    }
  }
  console.log(
    `[drift-detector last-3] ${chosen} types=${[...byType.keys()].join(",")} — OK`,
  );
});

function realCcSampleCandidates(): string[] {
  const home = homedir();
  // Prefer the current project's recordings; fall back to any session dir.
  const primary = join(home, ".claude", "projects", "-Users-i060912-SAPDevelop-channel");
  return [primary];
}
