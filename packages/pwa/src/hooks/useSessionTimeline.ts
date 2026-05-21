import { useMemo } from "react";
import type { PwaPermissionRequest, PwaPermissionResolved } from "@cc-remote/proto";
import { mergeTimeline } from "../lib/timeline";
import type { TimelineEvent } from "../screens/timeline/types";
import { eventKey, type UseHubResult } from "../ws";

export interface UseSessionTimelineResult {
  items: TimelineEvent[];
  loadEarlier: () => void;
  composerBlocked: boolean;
  online: boolean;
  pendingInThisSession?: PwaPermissionRequest;
}

export interface SelectedSession {
  daemon_id: string;
  session_id: string;
}

/**
 * Derives the merged timeline + composer/online flags for one selected session.
 *
 * `resolved` is intentionally always empty in v1: the hub only broadcasts
 * permission_resolved frames live (no persistence), and `useHub` removes the
 * matching pending entry on resolve. So once a permission is resolved there
 * is no live source for the resolved card. This hook accepts the gap and
 * does not synthesize history. (Spec §2.5 — daemon-side persistence is the
 * future fix.)
 */
export function useSessionTimeline(
  hub: UseHubResult,
  selected: SelectedSession | null,
): UseSessionTimelineResult {
  return useMemo(() => {
    if (!selected) {
      return {
        items: [],
        loadEarlier: () => {},
        composerBlocked: false,
        online: false,
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
    const online =
      !!daemon?.online &&
      !!daemon.sessions.some((s) => s.session_id === selected.session_id);

    const oldestOffset = events[0]?.jsonl_offset;
    const loadEarlier =
      oldestOffset === undefined
        ? () => {}
        : () => hub.requestHistory(selected.daemon_id, selected.session_id, oldestOffset, 50);

    return {
      items,
      loadEarlier,
      composerBlocked: pending.length > 0,
      online,
      pendingInThisSession: pending[0],
    };
  }, [hub, selected]);
}
