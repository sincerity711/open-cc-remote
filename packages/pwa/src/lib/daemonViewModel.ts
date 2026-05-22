import type {
  DaemonView,
  EventFrameForPwa,
  PwaPermissionRequest,
} from "@cc-remote/proto";
import type { SessionState } from "../screens/primitives/StatusChip";
import { eventKey } from "../hooks/useHub";

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
  online: boolean;
  sessions: SessionRowViewModel[];
}

export interface ComputeDaemonViewModelsArgs {
  daemons: DaemonView[];
  events: Record<string, EventFrameForPwa[]>;
  pendingPermissions: Record<string, PwaPermissionRequest>;
  completedCounts: Record<string, number>;
  idleSessions: Record<string, true>;
}

/**
 * Pure derivation. State priority (highest first):
 *   1. !daemon.online                                    → offline
 *   2. any pending permission for this session           → waiting
 *   3. idleSessions[k] is set                            → idle
 *   4. events[k] has at least one frame                  → working
 *   5. otherwise                                          → idle
 */
export function computeDaemonViewModels(
  args: ComputeDaemonViewModelsArgs,
): DaemonViewModel[] {
  const pendingByKey = groupPendingByKey(args.pendingPermissions);

  return args.daemons.map((d) => ({
    daemon_id: d.daemon_id,
    hostname: d.hostname,
    online: d.online,
    sessions: d.sessions.map((s) => {
      const k = eventKey(d.daemon_id, s.session_id);
      const pending = pendingByKey[k] ?? [];
      const evts = args.events[k] ?? [];
      const tasks = args.completedCounts[k] ?? 0;
      const unread = evts.length;

      const state: SessionState = !d.online
        ? "offline"
        : pending.length > 0
          ? "waiting"
          : args.idleSessions[k]
            ? "idle"
            : evts.length > 0
              ? "working"
              : "idle";

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
