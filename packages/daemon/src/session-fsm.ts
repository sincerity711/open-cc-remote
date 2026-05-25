import type { SessionState, AGUIEvent } from "@cc-remote/proto";
import { EventType } from "@cc-remote/proto";

/**
 * Session state machine. The daemon owns this — JSONL events and the
 * permission protocol are the two inputs; transitions emit notifications
 * the daemon turns into `session_state` frames for the hub/PWA.
 *
 * States ─────────────────────────────────────────────────────────────────
 *   idle     ← initial; either nothing happening, or end_turn + idle window elapsed
 *   working  ← actively producing output (any JSONL line that isn't a permission)
 *   waiting  ← one or more pending permission_requests; previous state stashed
 *
 * Transitions ────────────────────────────────────────────────────────────
 *   register                                             → idle
 *   onJsonlLine() while not waiting                      → working
 *   onIdleTimer() while not waiting                      → idle
 *   onPermissionRequest() (count++; if not waiting)      → waiting (push prev)
 *   onPermissionResolved() (count--; if 0 and waiting)   → pop prev
 *   remove()                                             → (entry deleted)
 *
 * "offline" is NOT a state in this FSM — the daemon process can't classify
 * itself as offline. The PWA derives that from !daemon.online.
 *
 * Notes:
 *   - onJsonlLine is fed for EVERY new line (user / assistant / system / …).
 *     The daemon caller is responsible for arming/canceling the idle timer
 *     based on assistant.stop_reason; the FSM doesn't peek into payloads.
 *   - We always push the prior state when entering `waiting` (even from
 *     `idle`) so multiple permission requests at once resolve cleanly back
 *     to the same starting state.
 */
export class SessionFsm {
  private entries = new Map<
    string,
    { state: SessionState; pendingCount: number; prevBeforeWaiting: SessionState }
  >();
  private listeners: ((session_id: string, state: SessionState, prev: SessionState) => void)[] = [];
  private runListeners: ((session_id: string, ev: AGUIEvent) => void)[] = [];

  onTransition(l: (session_id: string, state: SessionState, prev: SessionState) => void): void {
    this.listeners.push(l);
  }

  onRunEvent(l: (session_id: string, ev: AGUIEvent) => void): void {
    this.runListeners.push(l);
  }

  private fireRun(session_id: string, ev: AGUIEvent): void {
    for (const l of this.runListeners) l(session_id, ev);
  }

  onError(session_id: string, opts: { message: string; code?: string }): void {
    this.fireRun(session_id, {
      type: EventType.RUN_ERROR,
      message: opts.message,
      ...(opts.code ? { code: opts.code } : {}),
    } as AGUIEvent);
  }

  /** Get the current state, or undefined if the session is unknown. */
  get(session_id: string): SessionState | undefined {
    return this.entries.get(session_id)?.state;
  }

  /** Initial entry. No-op if already registered (idempotent for crash-restart).
   * Does NOT fire a transition — callers carry initial state via session_open. */
  register(session_id: string): void {
    if (this.entries.has(session_id)) return;
    this.entries.set(session_id, { state: "idle", pendingCount: 0, prevBeforeWaiting: "idle" });
  }

  /** Drop the session. No transition emitted (caller is doing session_close). */
  remove(session_id: string): void {
    this.entries.delete(session_id);
  }

  onJsonlLine(session_id: string): void {
    const cur = this.entries.get(session_id);
    if (!cur) return;
    if (cur.state === "waiting") {
      // permission overrides — record the side-effect (we'd be working) so a
      // later resolve returns to working, not idle.
      cur.prevBeforeWaiting = "working";
      return;
    }
    this.transition(session_id, "working");
  }

  onIdleTimer(session_id: string): void {
    const cur = this.entries.get(session_id);
    if (!cur) return;
    if (cur.state === "waiting") {
      cur.prevBeforeWaiting = "idle";
      return;
    }
    this.transition(session_id, "idle");
  }

  onPermissionRequest(session_id: string): void {
    let cur = this.entries.get(session_id);
    if (!cur) {
      // Ungistered session asking for permission — register lazily as idle.
      this.register(session_id);
      cur = this.entries.get(session_id)!;
    }
    cur.pendingCount += 1;
    if (cur.state === "waiting") return;
    cur.prevBeforeWaiting = cur.state;
    this.transition(session_id, "waiting");
  }

  onPermissionResolved(session_id: string): void {
    const cur = this.entries.get(session_id);
    if (!cur) return;
    cur.pendingCount = Math.max(0, cur.pendingCount - 1);
    if (cur.pendingCount > 0) return;
    if (cur.state !== "waiting") return;
    this.transition(session_id, cur.prevBeforeWaiting);
  }

  private transition(session_id: string, next: SessionState): void {
    const cur = this.entries.get(session_id);
    if (!cur) return;
    const prev = cur.state;
    if (prev === next) return;
    cur.state = next;
    for (const l of this.listeners) l(session_id, next, prev);
    // Emit RUN_* lifecycle events alongside state-transition notifications.
    if (prev === "idle" && next === "working") {
      const runId = `${session_id}:${Date.now()}`;
      this.fireRun(session_id, {
        type: EventType.RUN_STARTED,
        threadId: session_id,
        runId,
      } as AGUIEvent);
    } else if (prev === "working" && next === "idle") {
      const runId = `${session_id}:${Date.now()}`;
      this.fireRun(session_id, {
        type: EventType.RUN_FINISHED,
        threadId: session_id,
        runId,
      } as AGUIEvent);
    }
  }
}
