import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import * as path from "node:path";
import {
  handleFsList,
  getWhitelistRoots,
  resetWhitelistRootsForTest,
} from "./fs-list.ts";

// Each test gets a fresh tmp dir we treat as a fake "home" / extra root.
let tmpRoot: string;
let originalEnv: string | undefined;

beforeEach(() => {
  tmpRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "fs-list-test-")));
  originalEnv = process.env.CC_REMOTE_FS_ROOTS;
  resetWhitelistRootsForTest();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  if (originalEnv === undefined) delete process.env.CC_REMOTE_FS_ROOTS;
  else process.env.CC_REMOTE_FS_ROOTS = originalEnv;
  resetWhitelistRootsForTest();
});

test("forbidden path far outside the whitelist returns error: forbidden", async () => {
  // Whitelist only the tmpRoot; ask for /etc which is nowhere near it.
  const r = await handleFsList(
    { request_id: "r1", path: "/etc" },
    { roots: [tmpRoot] },
  );
  expect(r.ok).toBe(false);
  expect(r.error).toBe("forbidden");
  expect(r.request_id).toBe("r1");
});

test("nonexistent path returns error: not_found", async () => {
  const missing = path.join(tmpRoot, "does-not-exist");
  const r = await handleFsList(
    { request_id: "r2", path: missing },
    { roots: [tmpRoot] },
  );
  expect(r.ok).toBe(false);
  expect(r.error).toBe("not_found");
});

test("normal listing is sorted with dotfiles last and case-insensitive within group", async () => {
  // Layout:
  //   tmpRoot/
  //     Apple/         (dir)
  //     banana/        (dir)
  //     cherry.txt     (file)
  //     .hidden        (file)
  //     .alpha/        (dir)
  mkdirSync(path.join(tmpRoot, "Apple"));
  mkdirSync(path.join(tmpRoot, "banana"));
  writeFileSync(path.join(tmpRoot, "cherry.txt"), "x");
  writeFileSync(path.join(tmpRoot, ".hidden"), "y");
  mkdirSync(path.join(tmpRoot, ".alpha"));

  const r = await handleFsList(
    { request_id: "r3", path: tmpRoot },
    { roots: [tmpRoot] },
  );
  expect(r.ok).toBe(true);
  expect(r.path).toBe(tmpRoot);
  const names = (r.entries ?? []).map((e) => e.name);
  // Visible group first (case-insensitive), then dot group (case-insensitive).
  expect(names).toEqual(["Apple", "banana", "cherry.txt", ".alpha", ".hidden"]);
  const byName = new Map((r.entries ?? []).map((e) => [e.name, e.is_dir]));
  expect(byName.get("Apple")).toBe(true);
  expect(byName.get("banana")).toBe(true);
  expect(byName.get("cherry.txt")).toBe(false);
  expect(byName.get(".alpha")).toBe(true);
  expect(byName.get(".hidden")).toBe(false);
});

test("listing is capped at 200 entries", async () => {
  for (let i = 0; i < 250; i++) {
    writeFileSync(path.join(tmpRoot, `f${String(i).padStart(3, "0")}.txt`), "");
  }
  const r = await handleFsList(
    { request_id: "r4", path: tmpRoot },
    { roots: [tmpRoot] },
  );
  expect(r.ok).toBe(true);
  expect(r.entries?.length).toBe(200);
});

test("~ expands to homedir (whitelist includes home by default)", async () => {
  // Use the real homedir + the default whitelist (which always includes it).
  const home = realpathSync(homedir());
  const r = await handleFsList({ request_id: "r5", path: "~" });
  expect(r.ok).toBe(true);
  expect(r.path).toBe(home);
  expect(Array.isArray(r.entries)).toBe(true);
});

test("CC_REMOTE_FS_ROOTS adds a root and lets paths under it through", async () => {
  // tmpRoot is outside $HOME; without the env it should be forbidden, with it
  // it should succeed. Verifies the env reaches getWhitelistRoots() after a
  // reset.
  const child = path.join(tmpRoot, "sub");
  mkdirSync(child);

  // Without the env, default roots = [home]. tmpRoot is outside, so forbidden.
  const before = await handleFsList({ request_id: "r6a", path: child });
  expect(before.ok).toBe(false);
  expect(before.error).toBe("forbidden");

  // Add tmpRoot via env, refresh the cache, and the same call should succeed.
  process.env.CC_REMOTE_FS_ROOTS = tmpRoot;
  resetWhitelistRootsForTest();
  const roots = getWhitelistRoots();
  expect(roots).toContain(tmpRoot);

  const after = await handleFsList({ request_id: "r6b", path: child });
  expect(after.ok).toBe(true);
  expect(after.path).toBe(realpathSync(child));
});

test("root '/' lets every absolute path through (no double-slash bug)", async () => {
  // Earlier `isUnderRoot` did `resolved.startsWith(root + path.sep)`, which
  // for root === "/" became startsWith("//") and matched nothing. Lock that
  // in by listing tmpRoot (which is absolute and under "/" by definition)
  // with root = "/". Only meaningful on POSIX-like systems where path.sep="/"
  // — which is every platform we run the daemon on.
  if (path.sep !== "/") return;
  const child = path.join(tmpRoot, "rooted");
  mkdirSync(child);
  const r = await handleFsList(
    { request_id: "r7", path: child },
    { roots: ["/"] },
  );
  expect(r.ok).toBe(true);
  expect(r.path).toBe(realpathSync(child));
});
