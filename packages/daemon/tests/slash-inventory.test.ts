import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanInventory } from "../src/slash-inventory.ts";

function tmp() {
  return mkdtempSync(join(tmpdir(), "slash-inv-"));
}

test("returns the three built-in entries when no .claude dirs exist", async () => {
  const home = tmp();
  const cwd = tmp();
  try {
    const entries = await scanInventory({ cwd, homeDir: home });
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(["/clear", "/compact", "/context"]);
    expect(entries.every((e) => e.source === "builtin")).toBe(true);
    expect(entries.every((e) => e.id.startsWith("builtin:"))).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("scans user commands with frontmatter description and argument-hint", async () => {
  const home = tmp();
  const cwd = tmp();
  try {
    const cmdDir = join(home, ".claude", "commands");
    mkdirSync(cmdDir, { recursive: true });
    writeFileSync(join(cmdDir, "review.md"),
      "---\n" +
      "description: Review the current diff\n" +
      "argument-hint: \"[paths]\"\n" +
      "---\n\nBody here.\n",
    );
    const entries = await scanInventory({ cwd, homeDir: home });
    const review = entries.find((e) => e.name === "/review");
    expect(review).toBeDefined();
    expect(review!.source).toBe("user");
    expect(review!.id).toBe("user:review");
    expect(review!.description).toBe("Review the current diff");
    expect(review!.argument_hint).toBe("[paths]");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("scans project commands separately from user commands", async () => {
  const home = tmp();
  const cwd = tmp();
  try {
    mkdirSync(join(cwd, ".claude", "commands"), { recursive: true });
    writeFileSync(join(cwd, ".claude", "commands", "deploy.md"),
      "---\ndescription: Project-only deploy\n---\nBody\n");
    const entries = await scanInventory({ cwd, homeDir: home });
    const deploy = entries.find((e) => e.name === "/deploy");
    expect(deploy).toBeDefined();
    expect(deploy!.source).toBe("project");
    expect(deploy!.id).toBe("project:deploy");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("scans skills as <home>/.claude/skills/<dir>/SKILL.md", async () => {
  const home = tmp();
  const cwd = tmp();
  try {
    const skillDir = join(home, ".claude", "skills", "brainstorming");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\ndescription: Idea to design\n---\nbody\n");
    const entries = await scanInventory({ cwd, homeDir: home });
    const skill = entries.find((e) => e.name === "/brainstorming");
    expect(skill).toBeDefined();
    expect(skill!.source).toBe("skill");
    expect(skill!.id).toBe("skill:brainstorming");
    expect(skill!.description).toBe("Idea to design");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("malformed frontmatter file is parsed by name even if metadata absent", async () => {
  const home = tmp();
  const cwd = tmp();
  try {
    const cmdDir = join(home, ".claude", "commands");
    mkdirSync(cmdDir, { recursive: true });
    writeFileSync(join(cmdDir, "ok.md"), "---\ndescription: fine\n---\n");
    writeFileSync(join(cmdDir, "bad.md"), "no frontmatter at all here\n");
    const entries = await scanInventory({ cwd, homeDir: home });
    const names = entries.map((e) => e.name);
    expect(names).toContain("/ok");
    expect(names).toContain("/bad");
    const bad = entries.find((e) => e.name === "/bad")!;
    expect(bad.description).toBeUndefined();
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
