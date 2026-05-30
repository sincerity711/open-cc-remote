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

test("filterEntries: word-start match ranks below prefix, above subseq", () => {
  // `/code-review` should be reachable by typing `/rev` (matches the
  // word-start of the second segment).
  const fancy: SlashEntry[] = [
    { id: "code-review", name: "/code-review", source: "builtin", description: "" },
    { id: "review-only", name: "/review-only", source: "builtin", description: "" },
    { id: "compact", name: "/compact", source: "builtin", description: "" },
  ];
  const names = filterEntries(fancy, "/rev").map((e) => e.name);
  // /review-only wins (prefix score 3) over /code-review (word-start score 2).
  expect(names).toEqual(["/review-only", "/code-review"]);
});

test("filterEntries: subsequence fallback for fuzzy typos", () => {
  // `/scrl` → matches `/security-rule` as a subsequence.
  const fancy: SlashEntry[] = [
    { id: "security-rule", name: "/security-rule", source: "builtin", description: "" },
    { id: "compact", name: "/compact", source: "builtin", description: "" },
  ];
  const names = filterEntries(fancy, "/scrl").map((e) => e.name);
  expect(names).toEqual(["/security-rule"]);
});

test("filterEntries: prefix still beats word-start beats subseq", () => {
  const fancy: SlashEntry[] = [
    { id: "co1", name: "/code", source: "builtin", description: "" },         // prefix
    { id: "co2", name: "/sub-code", source: "builtin", description: "" },      // word-start
    { id: "co3", name: "/c-o-d-e", source: "builtin", description: "" },       // subseq only
  ];
  const ids = filterEntries(fancy, "/cod").map((e) => e.id);
  expect(ids).toEqual(["co1", "co2", "co3"]);
});

test("filterEntries: exact full command name still single-matches (Enter passthrough)", () => {
  // The component depends on this for Enter-to-submit when a single exact
  // match remains. Fuzzy must not pull other entries up to dilute it.
  const result = filterEntries(ENTRIES, "/clear");
  expect(result.length).toBe(1);
  expect(result[0]!.name).toBe("/clear");
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
