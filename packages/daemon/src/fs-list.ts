import { realpath, readdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type {
  DaemonFsListResult,
  FsListEntry,
  FsListErrorCode,
  HubToDaemonFsList,
} from "@cc-remote/proto";

// Hard cap on entries returned to the PWA. Folder autocomplete only ever
// shows a handful of options at a time, so a generous cap is plenty and
// keeps `fs_list_result` frames bounded for huge directories like
// node_modules.
const MAX_ENTRIES = 200;

// Module-load cache of the whitelisted roots. Recomputed on demand by
// resetWhitelistRootsForTest so tests can flip CC_REMOTE_FS_ROOTS.
let cachedRoots: string[] | null = null;

/**
 * Resolve a path the way the daemon stores roots — realpath if it exists
 * (so a symlinked HOME collapses onto the same canonical form callers
 * will see post-realpath at request time), otherwise a plain `path.resolve`
 * so a configured-but-missing root degrades gracefully (it just won't
 * match).
 */
function resolveRoot(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function computeWhitelistRoots(): string[] {
  const roots = new Set<string>();
  roots.add(resolveRoot(os.homedir()));
  const env = process.env.CC_REMOTE_FS_ROOTS;
  if (env) {
    for (const raw of env.split(":")) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      roots.add(resolveRoot(trimmed));
    }
  }
  return [...roots];
}

/** Whitelisted roots used for the prefix check. Lazily computed + cached. */
export function getWhitelistRoots(): string[] {
  if (cachedRoots === null) cachedRoots = computeWhitelistRoots();
  return cachedRoots;
}

/**
 * Test helper: drop the cached whitelist so the next call recomputes from
 * the current `os.homedir()` + `CC_REMOTE_FS_ROOTS`. Production code never
 * calls this — the cache is built once at first use.
 */
export function resetWhitelistRootsForTest(): void {
  cachedRoots = null;
}

function expandTilde(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

function isUnderRoot(resolved: string, root: string): boolean {
  return resolved === root || resolved.startsWith(root + path.sep);
}

function classifyReaddirError(err: unknown): FsListErrorCode {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") return "not_found";
  if (code === "EACCES" || code === "EPERM") return "forbidden";
  return "io";
}

function compareEntries(a: FsListEntry, b: FsListEntry): number {
  const aDot = a.name.startsWith(".");
  const bDot = b.name.startsWith(".");
  if (aDot !== bDot) return aDot ? 1 : -1;
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

export interface HandleFsListOptions {
  /** Override the whitelist (tests). Falls back to module cache. */
  roots?: string[];
}

/**
 * Resolve + whitelist-check + list a directory for an `fs_list` request.
 * Returns the `DaemonFsListResult` to ship back over the hub conn.
 *
 * Pure-ish: only touches the filesystem; no logging, no global state aside
 * from the whitelist cache (overridable via opts.roots for tests).
 */
export async function handleFsList(
  frame: Pick<HubToDaemonFsList, "request_id" | "path">,
  opts: HandleFsListOptions = {},
): Promise<DaemonFsListResult> {
  const requestId = frame.request_id;
  const roots = opts.roots ?? getWhitelistRoots();

  const expanded = expandTilde(frame.path);
  const absolute = path.resolve(expanded);

  let resolved: string;
  try {
    resolved = await realpath(absolute);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { type: "fs_list_result", request_id: requestId, ok: false, error: "not_found" };
    }
    if (code === "EACCES" || code === "EPERM") {
      return { type: "fs_list_result", request_id: requestId, ok: false, error: "forbidden" };
    }
    return { type: "fs_list_result", request_id: requestId, ok: false, error: "io" };
  }

  const allowed = roots.some((root) => isUnderRoot(resolved, root));
  if (!allowed) {
    return { type: "fs_list_result", request_id: requestId, ok: false, error: "forbidden" };
  }

  let dirents;
  try {
    dirents = await readdir(resolved, { withFileTypes: true });
  } catch (err) {
    return {
      type: "fs_list_result",
      request_id: requestId,
      ok: false,
      error: classifyReaddirError(err),
    };
  }

  const entries: FsListEntry[] = dirents.map((d) => ({
    name: d.name,
    is_dir: d.isDirectory(),
  }));
  entries.sort(compareEntries);
  const capped = entries.length > MAX_ENTRIES ? entries.slice(0, MAX_ENTRIES) : entries;

  return {
    type: "fs_list_result",
    request_id: requestId,
    ok: true,
    path: resolved,
    entries: capped,
  };
}
