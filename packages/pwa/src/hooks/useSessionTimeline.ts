import { useEffect, useMemo, useRef } from "react";
import type { PwaPermissionRequest, PwaPermissionResolved } from "@cc-remote/proto";
import { mergeTimeline } from "../lib/timeline";
import type { RenderItem } from "../screens/timeline/types";
import { eventKey, type UseHubResult } from "./useHub";

export interface UseSessionTimelineResult {
  items: RenderItem[];
  loadEarlier: () => void;
  hasMoreEarlier: boolean;
  composerBlocked: boolean;
  online: boolean;
  idle: boolean;
  pendingInThisSession?: PwaPermissionRequest;
}

export interface SelectedSession {
  daemon_id: string;
  session_id: string;
}

/** How many recent history events to pull when the user enters a session whose
 * live event buffer is empty (or when they explicitly click "Load earlier"). */
const HISTORY_PAGE_SIZE = 50;

/**
 * Derives the merged timeline + composer/online flags for one selected session.
 *
 * `resolved` is intentionally always empty in v1: the hub only broadcasts
 * permission_resolved frames live (no persistence), and `useHub` removes the
 * matching pending entry on resolve. So once a permission is resolved there
 * is no live source for the resolved card. This hook accepts the gap and
 * does not synthesize history. (Spec §2.5 — daemon-side persistence is the
 * future fix.)
 *
 * On session enter, if the live event buffer is empty, fires one
 * requestHistory(before_offset = MAX_SAFE_INTEGER) so the daemon returns
 * the most recent N JSONL lines. After that, scroll-to-top in
 * SessionTimeline triggers paged backfill via the same loadEarlier hook,
 * passing the oldest known offset.
 */
export function useSessionTimeline(
  hub: UseHubResult,
  selected: SelectedSession | null,
): UseSessionTimelineResult {
  const initialFetchedRef = useRef<Set<string>>(new Set());

  const result = useMemo(() => {
    if (!selected) {
      return {
        items: [] as RenderItem[],
        loadEarlier: () => {},
        hasMoreEarlier: false,
        composerBlocked: false,
        online: false,
        idle: false,
        pendingInThisSession: undefined as PwaPermissionRequest | undefined,
      };
    }
    const k = eventKey(selected.daemon_id, selected.session_id);
    const events = hub.events[k] ?? [];
    const chat = hub.chatMessages[k] ?? [];
    const pending = Object.values(hub.pendingPermissions).filter(
      (p) => p.daemon_id === selected.daemon_id && p.session_id === selected.session_id,
    );
    const resolved: PwaPermissionResolved[] = [];

    const items = mergeTimeline({ events, chat, pending, resolved });

    const daemon = hub.daemons.find((d) => d.daemon_id === selected.daemon_id);
    const session = daemon?.sessions.find((s) => s.session_id === selected.session_id);
    const online = !!daemon?.online && !!session;
    const idle = session?.state === "idle";

    // before_offset = oldest known event's offset, or MAX_SAFE_INTEGER if the
    // buffer is empty (daemon then returns the tail of the JSONL file).
    const beforeOffset = events[0]?.jsonl_offset ?? Number.MAX_SAFE_INTEGER;
    const loadEarlier = () =>
      hub.requestHistory(
        selected.daemon_id,
        selected.session_id,
        beforeOffset,
        HISTORY_PAGE_SIZE,
      );

    return {
      items,
      loadEarlier,
      hasMoreEarlier: !hub.noMoreHistory[k],
      composerBlocked: pending.length > 0,
      online,
      idle,
      pendingInThisSession: pending[0],
    };
  }, [hub, selected]);

  // Auto-load history on first entry into a session whose live buffer is empty.
  // The set of already-fetched-on-entry session keys lives in a ref so a remount
  // (e.g. layout reflow) doesn't re-spam requestHistory.
  useEffect(() => {
    if (!selected) return;
    const k = eventKey(selected.daemon_id, selected.session_id);
    if (initialFetchedRef.current.has(k)) return;
    if ((hub.events[k]?.length ?? 0) > 0) {
      // Buffer was populated since selection — no need to backfill.
      initialFetchedRef.current.add(k);
      return;
    }
    initialFetchedRef.current.add(k);
    hub.requestHistory(
      selected.daemon_id,
      selected.session_id,
      Number.MAX_SAFE_INTEGER,
      HISTORY_PAGE_SIZE,
    );
  }, [selected, hub]);

  return result;
}
