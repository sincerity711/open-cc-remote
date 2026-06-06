import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { spawn as childSpawn } from "node:child_process";
import path from "node:path";

/**
 * Reconcile-only registry of tmux sessions spawned by this daemon.
 *
 * Persisted at `<state_dir>/runtime/tmux-sessions.json`. The registry NEVER
 * starts or kills processes; it only records what we spawned and reconciles
 * its view against `tmux list-sessions` on boot.
 *
 * Algorithm: spec at `docs/superpowers/specs/2026-06-07-process-registry-design.md`.
 */

export interface TmuxSessionEntry {
  tmux_name: string;
  cwd: string;
  spawn_command: string;
  created_at_ms: number;
  request_id: string | null;
}

export interface TmuxSessionRegistryFile {
  version: 1;
  sessions: TmuxSessionEntry[];
}

export interface ProcessRegistry {
  add(entry: TmuxSessionEntry): Promise<void>;
  remove(tmux_name: string): Promise<void>;
  list(): Promise<TmuxSessionEntry[]>;
  reconcile(opts?: {
    listAlive?: () => Promise<Set<string>>;
  }): Promise<{ kept: number; dropped: number }>;
}

export const REGISTRY_RELATIVE_PATH = path.join("runtime", "tmux-sessions.json");

export function resolveRegistryPath(stateDir: string): string {
  return path.join(stateDir, REGISTRY_RELATIVE_PATH);
}

interface CreateOpts {
  stateDir: string;
  log?: (m: string) => void;
}

const EMPTY: TmuxSessionRegistryFile = { version: 1, sessions: [] };

export function createProcessRegistry(opts: CreateOpts): ProcessRegistry {
  const filePath = resolveRegistryPath(opts.stateDir);
  const tmpPath = filePath + ".tmp";
  const log = opts.log ?? (() => {});

  // Serialization: every public method appends to this chain so concurrent
  // calls do not race on the file. The chain swallows errors per-step so a
  // failed call doesn't poison subsequent ones.
  let chain: Promise<unknown> = Promise.resolve();

  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = chain.then(() => fn(), () => fn());
    chain = next.catch(() => {});
    return next;
  }

  async function readFileSafe(): Promise<TmuxSessionRegistryFile> {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return { ...EMPTY, sessions: [] };
      log(`process-registry: read failed (${err.message}); treating as empty`);
      return { ...EMPTY, sessions: [] };
    }
    try {
      const parsed = JSON.parse(raw) as Partial<TmuxSessionRegistryFile>;
      const sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
      // Filter to entries that have at minimum a tmux_name; tolerate extra
      // unknown fields per the forward-compat clause in the spec.
      const cleaned: TmuxSessionEntry[] = [];
      for (const s of sessions) {
        if (s && typeof (s as TmuxSessionEntry).tmux_name === "string") {
          cleaned.push(s as TmuxSessionEntry);
        }
      }
      return { version: 1, sessions: cleaned };
    } catch (e) {
      log(`process-registry: parse failed (${(e as Error).message}); treating as empty`);
      return { ...EMPTY, sessions: [] };
    }
  }

  async function writeFileAtomic(state: TmuxSessionRegistryFile): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    // The .tmp is always overwritten — never read as fallback. A stale .tmp
    // from a crashed previous run is scratch space and gets clobbered here.
    await writeFile(tmpPath, JSON.stringify(state, null, 2), "utf8");
    await rename(tmpPath, filePath);
  }

  async function mutate(
    fn: (cur: TmuxSessionRegistryFile) => TmuxSessionRegistryFile,
  ): Promise<TmuxSessionRegistryFile> {
    const cur = await readFileSafe();
    const next = fn(cur);
    await writeFileAtomic(next);
    return next;
  }

  return {
    async add(entry) {
      return enqueue(async () => {
        await mutate((cur) => {
          const filtered = cur.sessions.filter((s) => s.tmux_name !== entry.tmux_name);
          return { version: 1, sessions: [...filtered, entry] };
        });
      });
    },

    async remove(tmux_name) {
      return enqueue(async () => {
        await mutate((cur) => ({
          version: 1,
          sessions: cur.sessions.filter((s) => s.tmux_name !== tmux_name),
        }));
      });
    },

    async list() {
      return enqueue(async () => {
        const cur = await readFileSafe();
        return cur.sessions.slice();
      });
    },

    async reconcile(reconcileOpts) {
      return enqueue(async () => {
        const listAlive = reconcileOpts?.listAlive ?? listAliveTmuxSessions;
        const cur = await readFileSafe();

        let alive: Set<string>;
        try {
          alive = await listAlive();
        } catch (e) {
          // Fail-safe: a transient tmux failure (binary missing, permission
          // error, etc.) must NOT cause us to drop entries. Persist the file
          // as-is (so a missing file still gets materialized) and report
          // dropped=0.
          log(`process-registry: listAlive failed (${(e as Error).message}); keeping all entries`);
          await writeFileAtomic(cur);
          return { kept: cur.sessions.length, dropped: 0 };
        }

        const survivors = cur.sessions.filter((s) => alive.has(s.tmux_name));
        const next: TmuxSessionRegistryFile = { version: 1, sessions: survivors };
        await writeFileAtomic(next);
        return { kept: survivors.length, dropped: cur.sessions.length - survivors.length };
      });
    },
  };
}

/**
 * Authoritative liveness oracle for the registry.
 *
 * Returns the set of tmux session names known to the local tmux server.
 *
 *   - exit 0           → parse stdout, return as Set
 *   - "no server running" (stderr match) → empty set (legitimate empty state)
 *   - ENOENT (tmux binary missing)        → throws so reconcile can fail-safe
 *   - any other error                     → throws so reconcile can fail-safe
 */
export function listAliveTmuxSessions(): Promise<Set<string>> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let p;
    try {
      p = childSpawn("tmux", ["list-sessions", "-F", "#{session_name}"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      reject(e as Error);
      return;
    }
    p.stdout?.on("data", (c: Buffer) => { stdout += c.toString(); });
    p.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); });
    p.on("error", (e) => reject(e));
    p.on("close", (code) => {
      if (code === 0) {
        const names = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        resolve(new Set(names));
        return;
      }
      // tmux >= 3 prints "no server running on /tmp/tmux-1000/default" to
      // stderr when no tmux daemon is up. That's a legitimate empty state,
      // not an error.
      if (/no server running/i.test(stderr)) {
        resolve(new Set());
        return;
      }
      reject(new Error(`tmux list-sessions exited ${code}: ${stderr.trim() || "(no stderr)"}`));
    });
  });
}
