import { useEffect, useMemo, useRef, useState } from "react";
import type { PwaPermissionRequest } from "@cc-remote/proto";

export interface PermissionQueueState {
  open: boolean;
  /** The request currently shown in the surface, or null if none. */
  active: PwaPermissionRequest | null;
  queueIndex: number;
  queueSize: number;
  /** Set transiently when the active request was resolved by another device. */
  handledNotice: boolean;
  openSurface: () => void;
  closeSurface: () => void;
  /** Advance past the current request — used after local allow/deny. */
  advance: () => void;
}

export function usePermissionQueue(
  pendingPermissions: Record<string, PwaPermissionRequest>,
): PermissionQueueState {
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [handledNotice, setHandledNotice] = useState(false);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const queue = useMemo(() => Object.values(pendingPermissions), [pendingPermissions]);

  // Choose / refresh the active request.
  useEffect(() => {
    if (!open) {
      setActiveId(null);
      return;
    }
    const stillPresent = activeId !== null && pendingPermissions[activeId];
    if (stillPresent) return;

    if (activeId !== null && !pendingPermissions[activeId] && queue.length > 0) {
      // The active request was resolved elsewhere. Notify and advance.
      setHandledNotice(true);
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
      noticeTimer.current = setTimeout(() => setHandledNotice(false), 2500);
    }

    const head = queue[0];
    if (!head) {
      setOpen(false);
      setActiveId(null);
      return;
    }

    setActiveId(head.request_id);
  }, [open, activeId, pendingPermissions, queue]);

  // Cleanup notice timer on unmount.
  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
  }, []);

  const active = activeId !== null ? (pendingPermissions[activeId] ?? null) : null;
  const queueIndex = active
    ? Math.max(1, queue.findIndex((q) => q.request_id === active.request_id) + 1)
    : 0;

  return {
    open,
    active,
    queueIndex,
    queueSize: queue.length,
    handledNotice,
    openSurface: () => setOpen(true),
    closeSurface: () => {
      setOpen(false);
      setActiveId(null);
    },
    advance: () => {
      // Drop the active request locally; the next render picks the new head.
      if (activeId !== null) setActiveId(null);
    },
  };
}
