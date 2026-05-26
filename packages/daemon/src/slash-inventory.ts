import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { SlashEntry } from "@cc-remote/proto";

const BUILTIN: SlashEntry[] = [
  {
    id: "builtin:clear",
    name: "/clear",
    description: "Clear conversation history (keeps memory)",
    source: "builtin",
  },
  {
    id: "builtin:compact",
    name: "/compact",
    description: "Summarize the conversation to free context",
    argument_hint: "[focus instructions]",
    source: "builtin",
  },
  {
    id: "builtin:context",
    name: "/context",
    description: "Show current context window usage",
    source: "builtin",
  },
];

export interface ScanInput {
  cwd: string;
  homeDir: string;
}

export async function scanInventory(input: ScanInput): Promise<SlashEntry[]> {
  const out: SlashEntry[] = [...BUILTIN];

  await Promise.all([
    scanCommandDir(join(input.homeDir, ".claude", "commands"), "user", out),
    scanCommandDir(join(input.cwd, ".claude", "commands"), "project", out),
    scanSkillDir(join(input.homeDir, ".claude", "skills"), out),
    scanSkillDir(join(input.cwd, ".claude", "skills"), out),
  ]);

  return out;
}

async function scanCommandDir(
  dir: string,
  source: "user" | "project",
  out: SlashEntry[],
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const f of names) {
    if (!f.endsWith(".md")) continue;
    const basename = f.slice(0, -3);
    if (!isValidName(basename)) continue;
    const meta = await readFrontmatter(join(dir, f));
    out.push(makeEntry(source, basename, meta));
  }
}

async function scanSkillDir(dir: string, out: SlashEntry[]): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const dirName of names) {
    if (!isValidName(dirName)) continue;
    const skillFile = join(dir, dirName, "SKILL.md");
    try {
      const s = await stat(skillFile);
      if (!s.isFile()) continue;
    } catch {
      continue;
    }
    const meta = await readFrontmatter(skillFile);
    out.push(makeEntry("skill", dirName, meta));
  }
}

function makeEntry(
  source: SlashEntry["source"],
  basename: string,
  meta: { description?: string; argument_hint?: string },
): SlashEntry {
  const e: SlashEntry = {
    id: `${source}:${basename}`,
    name: `/${basename}`,
    source,
  };
  if (meta.description) e.description = meta.description;
  if (meta.argument_hint) e.argument_hint = meta.argument_hint;
  return e;
}

function isValidName(s: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_\-]*$/.test(s);
}

interface Meta { description?: string; argument_hint?: string }

async function readFrontmatter(path: string): Promise<Meta> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return {};
  }
  if (!text.startsWith("---\n")) return {};
  const end = text.indexOf("\n---", 4);
  if (end < 0) return {};
  const block = text.slice(4, end);
  const meta: Meta = {};
  for (const line of block.split("\n")) {
    const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.+?)\s*$/);
    if (!m) continue;
    const key = m[1]!;
    const raw = m[2]!;
    const val = stripQuotes(raw);
    if (key === "description") meta.description = val;
    else if (key === "argument-hint" || key === "argument_hint") meta.argument_hint = val;
  }
  return meta;
}

function stripQuotes(s: string): string {
  if ((s.startsWith("\"") && s.endsWith("\"")) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}
