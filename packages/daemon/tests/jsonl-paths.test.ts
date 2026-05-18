import { test, expect } from "bun:test";
import { join } from "node:path";
import { homedir } from "node:os";
import { encodeCwd, jsonlPath } from "../src/jsonl-paths.ts";

test("encodeCwd replaces slashes with dashes", () => {
  expect(encodeCwd("/Users/i060912/SAPDevelop/wave-repo-browser"))
    .toBe("-Users-i060912-SAPDevelop-wave-repo-browser");
});

test("encodeCwd handles trailing slash", () => {
  expect(encodeCwd("/Users/x/")).toBe("-Users-x");
});

test("encodeCwd handles single slash", () => {
  expect(encodeCwd("/")).toBe("-");
});

test("encodeCwd handles relative paths by leading slash", () => {
  // Edge case: defensively reject relative paths since Claude Code always
  // uses absolute. We just assert no crash.
  expect(encodeCwd("foo/bar")).toBe("foo-bar");
});

test("jsonlPath assembles ~/.claude/projects/<encoded>/<session>.jsonl", () => {
  const p = jsonlPath("/Users/x/proj", "abc-123");
  expect(p).toBe(join(homedir(), ".claude", "projects", "-Users-x-proj", "abc-123.jsonl"));
});

test("jsonlPath honors CLAUDE_PROJECTS_DIR override (if set)", () => {
  const orig = process.env.CLAUDE_PROJECTS_DIR;
  process.env.CLAUDE_PROJECTS_DIR = "/tmp/cc-projects";
  try {
    expect(jsonlPath("/x", "s1")).toBe("/tmp/cc-projects/-x/s1.jsonl");
  } finally {
    if (orig === undefined) delete process.env.CLAUDE_PROJECTS_DIR;
    else process.env.CLAUDE_PROJECTS_DIR = orig;
  }
});
