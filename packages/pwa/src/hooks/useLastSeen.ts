import { useCallback, useEffect, useRef, useState } from "react";
import { eventKey } from "./useHub";

const STORAGE_KEY = "cc_remote_last_seen_offsets";
const DEBOUNCE_MS = 200;

/**
 * Per-session "last seen" anchor — the max jsonl_offset the user has actually
 * seen. Both the HomeScreen unread badge and the Timeline "New events" pill
 * derive their counts from this anchor (events newer than it = unread).
 *
 * Persisted to localStorage so unread survives refresh; debounced 200ms with
 * a flush on visibilitychange / beforeunload to bound write churn while still
 * surviving a tab close. Cross-tab sync is intentionally not implemented —
 * last-writer-wins on next reload is acceptable per product call.
 */
export interface UseLastSeenResult {
  lastSeenOffsets: Record<string, number>;
  markSeen: (daemon_id: string, session_id: string, offset: number) => void;
}

function loadInitial(): Record<string, number> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function useLastSeen(): UseLastSeenResult {
  const [lastSeenOffsets, setLastSeenOffsets] = useState<Record<string, number>>(loadInitial);

  // Latest snapshot for the flush callback (which doesn't capture state).
  const latestRef = useRef(lastSeenOffsets);
  useEffect(() => { latestRef.current = lastSeenOffsets; }, [lastSeenOffsets]);

  const dirtyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(latestRef.current));
    } catch {
      // Quota / private mode — drop write; in-memory state still works.
    }
  }, []);

  const scheduleFlush = useCallback(() => {
    dirtyRef.current = true;
    if (timerRef.current) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      flush();
    }, DEBOUNCE_MS);
  }, [flush]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("beforeunload", flush);
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("beforeunload", flush);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [flush]);

  const markSeen = useCallback(
    (daemon_id: string, session_id: string, offset: number) => {
      if (!Number.isFinite(offset)) return;
      const k = eventKey(daemon_id, session_id);
      setLastSeenOffsets((prev) => {
        const cur = prev[k];
        // Monotonic — never regress (e.g. another device may have advanced
        // further; localStorage may have an older value than current state
        // after a re-mount; either way don't shrink unread).
        if (cur !== undefined && cur >= offset) return prev;
        scheduleFlush();
        return { ...prev, [k]: offset };
      });
    },
    [scheduleFlush],
  );

  return { lastSeenOffsets, markSeen };
}
