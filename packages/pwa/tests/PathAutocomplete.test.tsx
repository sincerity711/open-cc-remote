import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PathAutocomplete,
  splitPath,
  filterFsEntries,
  normalizeParent,
} from "../src/screens/primitives/PathAutocomplete";
import {
  findMentionAtCursor,
  resolveMentionPath,
  replaceMentionToken,
  nextTokenText,
} from "../src/screens/primitives/MentionAutocomplete";
import type { FsListEntry, PwaFsListResult } from "@cc-remote/proto";
import { nextActiveIndex } from "../src/screens/primitives/SlashMenu";

// ─── splitPath ──────────────────────────────────────────────────────────────

test("splitPath: empty value defaults to root parent + empty prefix", () => {
  expect(splitPath("")).toEqual({ parent: "/", prefix: "" });
});

test("splitPath: leading slash with no children", () => {
  expect(splitPath("/")).toEqual({ parent: "/", prefix: "" });
});

test("splitPath: splits on the last slash", () => {
  expect(splitPath("/Users/al")).toEqual({ parent: "/Users/", prefix: "al" });
  expect(splitPath("/Users/alice/proj")).toEqual({
    parent: "/Users/alice/",
    prefix: "proj",
  });
});

test("splitPath: trailing slash means no prefix", () => {
  expect(splitPath("/Users/")).toEqual({ parent: "/Users/", prefix: "" });
});

// ─── filterFsEntries ───────────────────────────────────────────────────────

const ENTRIES: FsListEntry[] = [
  { name: "Users", is_dir: true },
  { name: "usr", is_dir: true },
  { name: "var", is_dir: true },
  { name: "user-list.txt", is_dir: false },
  { name: "README", is_dir: false },
];

test("filterFsEntries: case-insensitive prefix match returns both 'U' and 'u' dirs", () => {
  const out = filterFsEntries(ENTRIES, "U", "all");
  expect(out.map((e) => e.name)).toEqual(["Users", "usr", "user-list.txt"]);
});

test("filterFsEntries: dirs first then alpha within group", () => {
  const out = filterFsEntries(ENTRIES, "", "all");
  // Dirs first sorted alpha (Users, usr, var), then files (README, user-list.txt).
  expect(out.map((e) => e.name)).toEqual([
    "Users",
    "usr",
    "var",
    "README",
    "user-list.txt",
  ]);
});

test("filterFsEntries: mode='dirs' filters out files", () => {
  const out = filterFsEntries(ENTRIES, "u", "dirs");
  expect(out.map((e) => e.name)).toEqual(["Users", "usr"]);
  expect(out.every((e) => e.is_dir)).toBe(true);
});

test("filterFsEntries: prefix Sap matches SAPDevelop (case-insensitive)", () => {
  const out = filterFsEntries(
    [{ name: "SAPDevelop", is_dir: true }, { name: "Library", is_dir: true }],
    "Sap",
    "dirs",
  );
  expect(out.map((e) => e.name)).toEqual(["SAPDevelop"]);
});

// ─── normalizeParent ────────────────────────────────────────────────────────

test("normalizeParent: root stays root", () => {
  expect(normalizeParent("/")).toBe("/");
});

test("normalizeParent: strips trailing slash", () => {
  expect(normalizeParent("/Users/")).toBe("/Users");
  expect(normalizeParent("/a/b/c/")).toBe("/a/b/c");
});

test("normalizeParent: passes through bare path", () => {
  expect(normalizeParent("/Users")).toBe("/Users");
});

// ─── nextActiveIndex (sanity, reused from SlashMenu) ────────────────────────

test("nextActiveIndex: wraps at the bounds for keyboard nav", () => {
  expect(nextActiveIndex(0, 3, -1)).toBe(2);
  expect(nextActiveIndex(2, 3, 1)).toBe(0);
});

// ─── PathAutocomplete render ────────────────────────────────────────────────

// SSR doesn't have focus events, so the popover only opens after focus on
// the client. To exercise rendering we provide a sender that synchronously
// invokes its callback so cache is pre-populated, then assert against the
// rendered <input>. The interactive popover gets covered by integration
// flows; here we lock in the input contract.

const NEVER_SENDER = (() => {
  return () => () => {};
})() as Parameters<typeof PathAutocomplete>[0]["sender"];

test("PathAutocomplete renders the underlying input with disabled + aria-label propagated", () => {
  const html = renderToStaticMarkup(
    <PathAutocomplete
      value="/Use"
      onChange={() => {}}
      daemonId="d1"
      mode="dirs"
      sender={NEVER_SENDER}
      inputProps={{
        "aria-label": "Working directory for mbp",
        placeholder: "/path/to/project",
        disabled: true,
      }}
    />,
  );
  expect(html).toContain('aria-label="Working directory for mbp"');
  expect(html).toContain('placeholder="/path/to/project"');
  expect(html).toContain("disabled");
  expect(html).toContain('value="/Use"');
});

test("PathAutocomplete: SSR markup never shows the popover (focus required)", () => {
  // With no focus on the server, the popover stays hidden — input only.
  const html = renderToStaticMarkup(
    <PathAutocomplete
      value="/U"
      onChange={() => {}}
      daemonId="d1"
      mode="dirs"
      sender={NEVER_SENDER}
    />,
  );
  expect(html).not.toContain('data-testid="path-autocomplete"');
});

// ─── MentionAutocomplete pure helpers ───────────────────────────────────────

test("findMentionAtCursor: cursor at end of @src/comp returns full token", () => {
  const draft = "look at @src/comp";
  const cursor = draft.length;
  const t = findMentionAtCursor(draft, cursor);
  expect(t).not.toBeNull();
  expect(t!.text).toBe("src/comp");
  expect(t!.start).toBe(8);
  expect(t!.end).toBe(draft.length);
});

test("findMentionAtCursor: cursor on whitespace (no token) returns null", () => {
  expect(findMentionAtCursor("hello world", 5)).toBeNull();
});

test("findMentionAtCursor: middle of token still matches", () => {
  const draft = "see @foo/bar there";
  // cursor between 'f' and 'o' of foo
  const t = findMentionAtCursor(draft, 6);
  expect(t).not.toBeNull();
  expect(t!.text).toBe("foo/bar");
});

test("findMentionAtCursor: standalone @ with no name still a token", () => {
  const t = findMentionAtCursor("hi @", 4);
  expect(t).not.toBeNull();
  expect(t!.text).toBe("");
});

test("findMentionAtCursor: word without @ isn't a token", () => {
  expect(findMentionAtCursor("hello", 3)).toBeNull();
});

// ─── resolveMentionPath ─────────────────────────────────────────────────────

test("resolveMentionPath: relative path joins onto cwd → '@src/comp'", () => {
  const r = resolveMentionPath("src/comp", "/work/repo");
  expect(r.parent).toBe("/work/repo/src/");
  expect(r.prefix).toBe("comp");
});

test("resolveMentionPath: absolute path used verbatim", () => {
  const r = resolveMentionPath("/abs/path", "/cwd");
  expect(r.parent).toBe("/abs/");
  expect(r.prefix).toBe("path");
});

test("resolveMentionPath: ./rel strips dot-slash before joining", () => {
  const r = resolveMentionPath("./README", "/work");
  expect(r.parent).toBe("/work/");
  expect(r.prefix).toBe("README");
});

test("resolveMentionPath: ~/foo passes ~ through unresolved (daemon resolves)", () => {
  const r = resolveMentionPath("~/foo", "/cwd");
  expect(r.parent).toBe("~/");
  expect(r.prefix).toBe("foo");
});

// ─── replaceMentionToken & nextTokenText ────────────────────────────────────

test("replaceMentionToken: replaces just the @-token, leaves rest intact", () => {
  const draft = "hey @sr/comp can you look";
  const tok = findMentionAtCursor(draft, 12)!;
  const next = replaceMentionToken(draft, tok, "src/components/", false);
  expect(next).toBe("hey @src/components/ can you look");
});

test("replaceMentionToken: file accept inserts trailing space", () => {
  const draft = "see @foo/bar end";
  const tok = findMentionAtCursor(draft, 11)!;
  const next = replaceMentionToken(draft, tok, "foo/bar.txt", true);
  expect(next).toBe("see @foo/bar.txt  end");
});

test("nextTokenText: keeps the directory portion of the token, swaps basename", () => {
  expect(nextTokenText("src/comp", { name: "components", is_dir: true })).toBe(
    "src/components/",
  );
  expect(nextTokenText("src/", { name: "App.tsx", is_dir: false })).toBe(
    "src/App.tsx",
  );
  expect(nextTokenText("", { name: "foo", is_dir: true })).toBe("foo/");
});

// ─── End-to-end "@src/comp" scenario from the spec ──────────────────────────

test("scenario: @src/comp with cwd=/work/repo → fs_list parent /work/repo/src/, prefix comp; selecting components/ keeps message intact", () => {
  const draft = "look at @src/comp now";
  const cursor = "look at @src/comp".length;
  const tok = findMentionAtCursor(draft, cursor)!;
  expect(tok.text).toBe("src/comp");

  const resolved = resolveMentionPath(tok.text, "/work/repo");
  expect(resolved.parent).toBe("/work/repo/src/");
  expect(resolved.prefix).toBe("comp");

  // Select a directory called "components" — token becomes src/components/
  const newToken = nextTokenText(tok.text, { name: "components", is_dir: true });
  expect(newToken).toBe("src/components/");

  // Replace and verify the rest of the message survives.
  const updated = replaceMentionToken(draft, tok, newToken, false);
  expect(updated).toBe("look at @src/components/ now");
});

// ─── useFsList cache helpers ────────────────────────────────────────────────

import { readCache, writeCache, clearCache } from "../src/hooks/useFsList";

test("useFsList cache: write then read within TTL hits", () => {
  clearCache();
  writeCache("d1", "/x", { status: "ready", entries: [{ name: "a", is_dir: true }] }, 1_000);
  const got = readCache("d1", "/x", 5_000);
  expect(got?.status).toBe("ready");
  expect(got?.entries.map((e) => e.name)).toEqual(["a"]);
});

test("useFsList cache: TTL expiry evicts entry", () => {
  clearCache();
  writeCache("d1", "/x", { status: "ready", entries: [] }, 0);
  const fresh = readCache("d1", "/x", 1_000);
  expect(fresh).not.toBeNull();
  const stale = readCache("d1", "/x", 60_000); // > 30s TTL
  expect(stale).toBeNull();
});

test("useFsList cache: keyed per daemon (different daemonIds don't collide)", () => {
  clearCache();
  writeCache("d1", "/x", { status: "ready", entries: [{ name: "from-d1", is_dir: false }] }, 0);
  writeCache("d2", "/x", { status: "ready", entries: [{ name: "from-d2", is_dir: false }] }, 0);
  expect(readCache("d1", "/x", 1)?.entries[0]?.name).toBe("from-d1");
  expect(readCache("d2", "/x", 1)?.entries[0]?.name).toBe("from-d2");
});

// ─── Frame integration smoke ────────────────────────────────────────────────

// Verify the proto types compile and the wire shape is what we expect.
test("proto: PwaFsListResult round-trips via JSON.parse without losing fields", () => {
  const frame: PwaFsListResult = {
    type: "fs_list_result",
    daemon_id: "d1",
    request_id: "rid-1",
    parent: "/Users",
    entries: [
      { name: "alice", is_dir: true },
      { name: "shared.txt", is_dir: false },
    ],
  };
  const parsed = JSON.parse(JSON.stringify(frame)) as PwaFsListResult;
  expect(parsed.entries?.length).toBe(2);
  expect(parsed.entries?.[0]?.name).toBe("alice");
});
