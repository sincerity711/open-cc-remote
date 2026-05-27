// SessionMap: daemon's join key for backward-attachment of JSONL events,
// hook callbacks, and permission relays back onto the round-trip's root
// trace.
//
// The map is keyed by session_id. The value is a stack so that two
// chat_in frames in flight (CC serializes, but the stack handles
// pathological cases) don't lose the older trace's parent context. A
// peek bumps lastActivity, and a periodic sweep ends + evicts entries
// whose last activity exceeds TTL.

import type { Context, Span } from "@opentelemetry/api";

export interface ActiveTrace {
  rootCtx: Context;
  rootSpan: Span;
  startedAt: number;
  lastActivityMs: number;
}

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

export class SessionMap {
  private readonly stacks = new Map<string, ActiveTrace[]>();
  private readonly ttlMs: number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private nowFn: () => number;

  constructor(opts: { ttlMs?: number; sweepIntervalMs?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.nowFn = opts.now ?? Date.now;
    const interval = opts.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    if (interval > 0) {
      this.sweepTimer = setInterval(() => this.sweep(), interval);
      // Don't keep the process alive just for the sweeper.
      (this.sweepTimer as { unref?: () => void }).unref?.();
    }
  }

  push(sessionId: string, entry: Omit<ActiveTrace, "startedAt" | "lastActivityMs">): void {
    const now = this.nowFn();
    const stack = this.stacks.get(sessionId) ?? [];
    stack.push({ ...entry, startedAt: now, lastActivityMs: now });
    this.stacks.set(sessionId, stack);
  }

  peek(sessionId: string): ActiveTrace | undefined {
    const stack = this.stacks.get(sessionId);
    if (!stack || stack.length === 0) return undefined;
    const top = stack[stack.length - 1]!;
    top.lastActivityMs = this.nowFn();
    return top;
  }

  pop(sessionId: string): ActiveTrace | undefined {
    const stack = this.stacks.get(sessionId);
    if (!stack || stack.length === 0) return undefined;
    const top = stack.pop()!;
    if (stack.length === 0) this.stacks.delete(sessionId);
    return top;
  }

  has(sessionId: string): boolean {
    const stack = this.stacks.get(sessionId);
    return !!stack && stack.length > 0;
  }

  size(): number {
    let total = 0;
    for (const stack of this.stacks.values()) total += stack.length;
    return total;
  }

  /**
   * End and evict any active trace whose lastActivity is older than ttlMs.
   * Exposed so tests can drive it deterministically (set sweepIntervalMs=0
   * in the constructor and call sweep() manually).
   */
  sweep(): number {
    const cutoff = this.nowFn() - this.ttlMs;
    let evicted = 0;
    for (const [sid, stack] of this.stacks) {
      const keep: ActiveTrace[] = [];
      for (const entry of stack) {
        if (entry.lastActivityMs < cutoff) {
          try {
            entry.rootSpan.end();
          } catch {
            // span might already be ended; ignore.
          }
          evicted++;
        } else {
          keep.push(entry);
        }
      }
      if (keep.length === 0) this.stacks.delete(sid);
      else this.stacks.set(sid, keep);
    }
    return evicted;
  }

  /** Stop the background sweep and end any still-active root spans. */
  dispose(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const stack of this.stacks.values()) {
      for (const entry of stack) {
        try {
          entry.rootSpan.end();
        } catch {
          // ignore
        }
      }
    }
    this.stacks.clear();
  }
}
