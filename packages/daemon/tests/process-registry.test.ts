import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  createProcessRegistry,
  resolveRegistryPath,
  type TmuxSessionEntry,
} from "../src/process-registry.ts";

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "ccr-pr-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function entry(name: string, overrides: Partial<TmuxSessionEntry> = {}): TmuxSessionEntry {
  return {
    tmux_name: name,
    cwd: "/tmp/x",
    spawn_command: "claude",
    created_at_ms: 1_700_000_000_000,
    request_id: null,
    ...overrides,
  };
}

test("add then list round-trips a single entry", async () => {
  const t = tmp();
  try {
    const reg = createProcessRegistry({ stateDir: t.dir });
    await reg.add(entry("cc-1", { cwd: "/tmp/foo" }));
    const got = await reg.list();
    expect(got).toHaveLength(1);
    expect(got[0]!.tmux_name).toBe("cc-1");
    expect(got[0]!.cwd).toBe("/tmp/foo");

    // File materialized at the spec'd relative path.
    const path = resolveRegistryPath(t.dir);
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.version).toBe(1);
    expect(parsed.sessions).toHaveLength(1);
  } finally { t.cleanup(); }
});

test("remove of unknown name is a no-op (no throw)", async () => {
  const t = tmp();
  try {
    const reg = createProcessRegistry({ stateDir: t.dir });
    await reg.add(entry("cc-1"));
    await reg.remove("cc-does-not-exist");
    const got = await reg.list();
    expect(got.map((s) => s.tmux_name)).toEqual(["cc-1"]);
  } finally { t.cleanup(); }
});

test("reconcile with missing file creates an empty registry", async () => {
  const t = tmp();
  try {
    const reg = createProcessRegistry({ stateDir: t.dir });
    const path = resolveRegistryPath(t.dir);
    expect(existsSync(path)).toBe(false);

    const res = await reg.reconcile({ listAlive: async () => new Set() });
    expect(res).toEqual({ kept: 0, dropped: 0 });
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed).toEqual({ version: 1, sessions: [] });
  } finally { t.cleanup(); }
});

test("reconcile when all entries are alive keeps them all", async () => {
  const t = tmp();
  try {
    const reg = createProcessRegistry({ stateDir: t.dir });
    await reg.add(entry("cc-1"));
    await reg.add(entry("cc-2"));
    await reg.add(entry("cc-3"));

    const res = await reg.reconcile({
      listAlive: async () => new Set(["cc-1", "cc-2", "cc-3"]),
    });
    expect(res).toEqual({ kept: 3, dropped: 0 });

    const got = await reg.list();
    expect(got.map((s) => s.tmux_name).sort()).toEqual(["cc-1", "cc-2", "cc-3"]);
  } finally { t.cleanup(); }
});

test("reconcile drops entries whose tmux is gone", async () => {
  const t = tmp();
  try {
    const reg = createProcessRegistry({ stateDir: t.dir });
    await reg.add(entry("cc-1"));
    await reg.add(entry("cc-2"));
    await reg.add(entry("cc-3"));

    const res = await reg.reconcile({
      listAlive: async () => new Set(["cc-1", "cc-3"]),
    });
    expect(res).toEqual({ kept: 2, dropped: 1 });

    const got = await reg.list();
    expect(got.map((s) => s.tmux_name).sort()).toEqual(["cc-1", "cc-3"]);
  } finally { t.cleanup(); }
});

test("reconcile fail-safes when listAlive throws ENOENT (tmux binary missing)", async () => {
  const t = tmp();
  try {
    const warnings: string[] = [];
    const reg = createProcessRegistry({
      stateDir: t.dir,
      log: (m) => warnings.push(m),
    });
    await reg.add(entry("cc-1"));
    await reg.add(entry("cc-2"));

    const res = await reg.reconcile({
      listAlive: async () => {
        const err = new Error("spawn tmux ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      },
    });
    expect(res).toEqual({ kept: 2, dropped: 0 });

    const got = await reg.list();
    expect(got).toHaveLength(2);
    expect(warnings.some((w) => /listAlive failed/.test(w))).toBe(true);
  } finally { t.cleanup(); }
});

test("reconcile drops everything when tmux server has no sessions ('no server running' empty set)", async () => {
  const t = tmp();
  try {
    const reg = createProcessRegistry({ stateDir: t.dir });
    await reg.add(entry("cc-1"));
    await reg.add(entry("cc-2"));

    // Distinguished from the ENOENT case by RESOLVING with empty set rather
    // than throwing — which is exactly what listAliveTmuxSessions does for
    // the "no server running" state.
    const res = await reg.reconcile({ listAlive: async () => new Set() });
    expect(res).toEqual({ kept: 0, dropped: 2 });

    const got = await reg.list();
    expect(got).toEqual([]);
  } finally { t.cleanup(); }
});

test("corrupt JSON on disk is treated as empty with a warning, no throw", async () => {
  const t = tmp();
  try {
    const path = resolveRegistryPath(t.dir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{not json", "utf8");

    const warnings: string[] = [];
    const reg = createProcessRegistry({
      stateDir: t.dir,
      log: (m) => warnings.push(m),
    });

    const res = await reg.reconcile({ listAlive: async () => new Set() });
    expect(res).toEqual({ kept: 0, dropped: 0 });
    expect(warnings.some((w) => /parse failed/.test(w))).toBe(true);

    // Subsequent operations work fine; file is now valid JSON.
    await reg.add(entry("cc-after-corrupt"));
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.sessions).toHaveLength(1);
  } finally { t.cleanup(); }
});

test("stale .tmp from a crashed write is overwritten, never used as fallback", async () => {
  const t = tmp();
  try {
    const finalPath = resolveRegistryPath(t.dir);
    const tmpPath = finalPath + ".tmp";
    mkdirSync(dirname(finalPath), { recursive: true });
    // Pre-seed both with mismatched garbage; only the final path must end up
    // valid after add().
    writeFileSync(tmpPath, "garbage-that-was-mid-write", "utf8");

    const reg = createProcessRegistry({ stateDir: t.dir });
    await reg.add(entry("cc-fresh"));

    const finalParsed = JSON.parse(readFileSync(finalPath, "utf8"));
    expect(finalParsed.version).toBe(1);
    expect(finalParsed.sessions).toHaveLength(1);
    expect(finalParsed.sessions[0].tmux_name).toBe("cc-fresh");

    // The .tmp should have been clobbered (renamed away). On POSIX the rename
    // moves the inode so the .tmp path no longer exists.
    expect(existsSync(tmpPath)).toBe(false);
  } finally { t.cleanup(); }
});

test("concurrent add() calls all land in the final file (serialization)", async () => {
  const t = tmp();
  try {
    const reg = createProcessRegistry({ stateDir: t.dir });
    // Fire 5 adds without awaiting individually; await Promise.all for
    // completion. Without serialization, last-writer-wins on a read-modify-
    // write pattern would leave only the last entry.
    await Promise.all([
      reg.add(entry("cc-a")),
      reg.add(entry("cc-b")),
      reg.add(entry("cc-c")),
      reg.add(entry("cc-d")),
      reg.add(entry("cc-e")),
    ]);

    const got = await reg.list();
    expect(got.map((s) => s.tmux_name).sort()).toEqual(["cc-a", "cc-b", "cc-c", "cc-d", "cc-e"]);
  } finally { t.cleanup(); }
});

test("add of an existing tmux_name replaces the prior entry (no duplicates)", async () => {
  const t = tmp();
  try {
    const reg = createProcessRegistry({ stateDir: t.dir });
    await reg.add(entry("cc-1", { cwd: "/old" }));
    await reg.add(entry("cc-1", { cwd: "/new" }));

    const got = await reg.list();
    expect(got).toHaveLength(1);
    expect(got[0]!.cwd).toBe("/new");
  } finally { t.cleanup(); }
});
