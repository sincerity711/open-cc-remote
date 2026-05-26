import type {
  DaemonView,
  PwaPermissionRequest,
} from "@cc-remote/proto";
import type { SessionState } from "../screens/primitives/StatusChip";
import { eventKey, type BufferedEvent } from "../hooks/useHub";

export interface SessionRowViewModel {
  daemon_id: string;
  session_id: string;
  name: string;
  model: string;
  cwd: string;
  activity: string;
  state: SessionState;
  unread: number;
  tasks: number;
}

export interface DaemonViewModel {
  daemon_id: string;
  hostname: string;
  display_name: string | null;
  online: boolean;
  sessions: SessionRowViewModel[];
}

export interface ComputeDaemonViewModelsArgs {
  daemons: DaemonView[];
  events: Record<string, BufferedEvent[]>;
  pendingPermissions: Record<string, PwaPermissionRequest>;
  completedCounts: Record<string, number>;
  /**
   * Per-session "last seen" anchor on jsonl_offset. Events with
   * `jsonl_offset > lastSeenOffsets[k]` count as unread. Missing key
   * means the user has never seen this session — every buffered event
   * is unread.
   */
  lastSeenOffsets?: Record<string, number>;
}

/**
 * Pure derivation. Source of truth for the per-session state is the daemon
 * FSM (carried on SessionSnapshot.state and updated by session_state frames).
 * The PWA only adds the "offline" projection — daemons can't classify
 * themselves as offline.
 *
 *   1. !daemon.online                      → offline
 *   2. otherwise                            → session.state (working|waiting|idle)
 */
export function computeDaemonViewModels(
  args: ComputeDaemonViewModelsArgs,
): DaemonViewModel[] {
  const pendingByKey = groupPendingByKey(args.pendingPermissions);
  const lastSeen = args.lastSeenOffsets ?? {};

  return args.daemons.map((d) => ({
    daemon_id: d.daemon_id,
    hostname: d.hostname,
    display_name: d.display_name,
    online: d.online,
    sessions: d.sessions.map((s) => {
      const k = eventKey(d.daemon_id, s.session_id);
      const pending = pendingByKey[k] ?? [];
      const evts = args.events[k] ?? [];
      const tasks = args.completedCounts[k] ?? 0;
      const seen = lastSeen[k];
      const unread = seen === undefined
        ? evts.length
        : evts.reduce((n, e) => (e.jsonl_offset > seen ? n + 1 : n), 0);

      const state: SessionState = !d.online ? "offline" : s.state;

      const activity = pickActivity(state, pending, tasks);

      return {
        daemon_id: d.daemon_id,
        session_id: s.session_id,
        name: pickSessionName(s.cwd, s.session_id),
        model: s.model ?? "-",
        cwd: s.cwd,
        activity,
        state,
        unread,
        tasks,
      };
    }),
  }));
}

function groupPendingByKey(
  pending: Record<string, PwaPermissionRequest>,
): Record<string, PwaPermissionRequest[]> {
  const result: Record<string, PwaPermissionRequest[]> = {};
  for (const req of Object.values(pending)) {
    const k = eventKey(req.daemon_id, req.session_id);
    (result[k] ??= []).push(req);
  }
  return result;
}

function pickActivity(
  state: SessionState,
  pending: PwaPermissionRequest[],
  tasks: number,
): string {
  if (state === "waiting") {
    const tool = pending[0]?.tool ?? "tool";
    return `permission needed (${tool})`;
  }
  if (state === "offline") return "offline";
  if (state === "idle") return tasks > 0 ? `idle - ${tasks} tasks done` : "idle";
  return "running";
}

/**
 * Derive a human-friendly session name. Prefer the cwd basename (e.g. "repo")
 * over a raw UUID; if cwd is empty or root, fall back to the first 8 chars
 * of session_id so we never leak a full UUID into the UI.
 */
function pickSessionName(cwd: string, session_id: string): string {
  if (cwd) {
    const trimmed = cwd.replace(/\/+$/, "");
    const base = trimmed.split("/").pop();
    if (base) return base;
  }
  return session_id.slice(0, 8);
}

/**
 * Convenience aggregation used by AppShell counters and HomeScreen mini card.
 */
export function totalPendingApprovals(
  pendingPermissions: Record<string, PwaPermissionRequest>,
): number {
  return Object.keys(pendingPermissions).length;
}
