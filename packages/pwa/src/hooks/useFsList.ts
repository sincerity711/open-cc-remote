import { useEffect, useRef, useState } from "react";
import type { FsListEntry, FsListErrorCode, PwaFsListResult } from "@cc-remote/proto";

export type FsListStatus = "idle" | "loading" | "ready" | "error";

export interface FsListState {
  status: FsListStatus;
  entries: FsListEntry[];
  error?: FsListErrorCode;
}

/**
 * Hub-driven path autocomplete data source. Sends `fs_list` for the
 * given parent and surfaces the result as listing state. Cached per
 * parent path for `CACHE_TTL_MS`; rapid parent changes are debounced
 * by `DEBOUNCE_MS` (an earlier in-flight request is allowed to resolve
 * — its result still updates the cache, but is discarded if a newer
 * request_id is now active).
 */
export const CACHE_TTL_MS = 30_000;
export const DEBOUNCE_MS = 150;

type Sender = (
  daemon_id: string,
  parent: string,
  request_id: string,
  onResult: (frame: PwaFsListResult) => void,
) => () => void;

interface CacheEntry {
  fetchedAt: number;
  state: FsListState;
}

// Module-level cache, keyed by `${daemon_id}::${parent}`. A small Map is
// fine — entries are tiny and 30s TTL bounds growth.
const cache = new Map<string, CacheEntry>();

function cacheKey(daemon_id: string, parent: string): string {
  return `${daemon_id}::${parent}`;
}

/** Pure helper exposed for tests. */
export function readCache(daemon_id: string, parent: string, now: number = Date.now()): FsListState | null {
  const k = cacheKey(daemon_id, parent);
  const hit = cache.get(k);
  if (!hit) return null;
  if (now - hit.fetchedAt > CACHE_TTL_MS) {
    cache.delete(k);
    return null;
  }
  return hit.state;
}

/** Pure helper exposed for tests. */
export function writeCache(daemon_id: string, parent: string, state: FsListState, now: number = Date.now()): void {
  cache.set(cacheKey(daemon_id, parent), { fetchedAt: now, state });
}

/** Pure helper exposed for tests. */
export function clearCache(): void {
  cache.clear();
}

/**
 * `parent` should be an absolute path. Callers normalize it (strip
 * trailing slash except for "/") before passing in. An empty `parent`
 * means "no request" — the hook returns idle state.
 *
 * `sender` is normally `useHub().sendFsList` but tests can pass a stub.
 */
export function useFsList(
  daemonId: string,
  parent: string,
  sender: Sender,
): FsListState {
  const [state, setState] = useState<FsListState>(() => {
    if (!daemonId || !parent) return { status: "idle", entries: [] };
    const cached = readCache(daemonId, parent);
    return cached ?? { status: "loading", entries: [] };
  });

  // Track the request_id that "owns" the current parent — late results
  // for an older parent still write to cache but don't replace state.
  const activeRequestRef = useRef<string | null>(null);

  useEffect(() => {
    if (!daemonId || !parent) {
      setState({ status: "idle", entries: [] });
      activeRequestRef.current = null;
      return;
    }

    // Cache hit — short-circuit. Still call setState so consumers re-render
    // with the cached entries when parent flips.
    const cached = readCache(daemonId, parent);
    if (cached) {
      setState(cached);
      activeRequestRef.current = null;
      return;
    }

    setState({ status: "loading", entries: [] });

    const requestId = (typeof crypto !== "undefined" && crypto.randomUUID)
      ? crypto.randomUUID()
      : `fsl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    activeRequestRef.current = requestId;

    let dispose: (() => void) | null = null;
    const debounceTimer = setTimeout(() => {
      dispose = sender(daemonId, parent, requestId, (frame) => {
        const next: FsListState = frame.error
          ? { status: "error", entries: [], error: frame.error }
          : { status: "ready", entries: frame.entries ?? [] };
        // Always update cache — even if the result is now stale, the next
        // user visit to this parent benefits. Daemon echoes the resolved
        // path back as `path`; fall back to the requested parent if the
        // daemon ran into an error before resolving.
        writeCache(daemonId, frame.path ?? parent, next);
        // Only update local state if this is still the active request.
        if (activeRequestRef.current === requestId) {
          setState(next);
        }
      });
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(debounceTimer);
      if (dispose) dispose();
      // Don't null activeRequestRef — a late callback that arrives between
      // teardown and the next effect should still be discarded by the
      // request_id mismatch.
    };
  }, [daemonId, parent, sender]);

  return state;
}
