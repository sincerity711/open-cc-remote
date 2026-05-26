import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SlashMenu,
  filterEntries,
  nextActiveIndex,
} from "../src/screens/primitives/SlashMenu";
import type { SlashEntry } from "@cc-remote/proto";

const ENTRIES: SlashEntry[] = [
  { id: "builtin:clear", name: "/clear", source: "builtin", description: "clear" },
  { id: "builtin:compact", name: "/compact", source: "builtin", description: "compact" },
  { id: "skill:brainstorming", name: "/brainstorming", source: "skill", description: "brainstorm" },
];

test("filterEntries: prefix match (case-insensitive) excludes leading slash", () => {
  expect(filterEntries(ENTRIES, "/cl").map((e) => e.id)).toEqual(["builtin:clear"]);
  expect(filterEntries(ENTRIES, "/CO").map((e) => e.id)).toEqual(["builtin:compact"]);
});

test("filterEntries: empty draft returns empty", () => {
  expect(filterEntries(ENTRIES, "")).toEqual([]);
  expect(filterEntries(ENTRIES, "hello")).toEqual([]);
});

test("filterEntries: bare '/' returns all (sorted)", () => {
  const names = filterEntries(ENTRIES, "/").map((e) => e.name);
  expect(names).toEqual(["/brainstorming", "/clear", "/compact"]);
});

test("filterEntries: hides menu once user types args (space after command)", () => {
  expect(filterEntries(ENTRIES, "/clear ")).toEqual([]);
  expect(filterEntries(ENTRIES, "/brainstorming todo")).toEqual([]);
});

test("nextActiveIndex: wraps at both ends", () => {
  expect(nextActiveIndex(0, 3, -1)).toBe(2);
  expect(nextActiveIndex(2, 3, 1)).toBe(0);
  expect(nextActiveIndex(1, 3, 1)).toBe(2);
  expect(nextActiveIndex(1, 3, -1)).toBe(0);
});

test("nextActiveIndex: empty list stays at 0", () => {
  expect(nextActiveIndex(0, 0, 1)).toBe(0);
});

test("SlashMenu renders nothing when no entries match", () => {
  const html = renderToStaticMarkup(
    <SlashMenu entries={ENTRIES} draft="/zzz" onSelect={() => {}} />,
  );
  expect(html).toBe("");
});

test("SlashMenu renders a row per filtered entry", () => {
  const html = renderToStaticMarkup(
    <SlashMenu entries={ENTRIES} draft="/c" onSelect={() => {}} />,
  );
  expect(html).toContain('data-testid="slash-row-builtin:clear"');
  expect(html).toContain('data-testid="slash-row-builtin:compact"');
  expect(html).not.toContain('data-testid="slash-row-skill:brainstorming"');
  // First row gets aria-selected (active=0 on initial render).
  expect(html).toMatch(/data-testid="slash-row-builtin:clear"[^>]*aria-selected="true"/);
});
