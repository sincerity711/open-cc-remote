// In-memory sliding-window rate limiter keyed on client IP.
// Per-bucket: timestamps of recent requests within the window. Periodic GC
// drops empty buckets so memory stays bounded.

export interface RateLimitConfig {
  pair_per_min: number;
  pair_refresh_per_min: number;
  ws_daemon_per_min: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  pair_per_min: 10,
  pair_refresh_per_min: 30,
  ws_daemon_per_min: 30,
};

export function loadRateLimitFromEnv(env: NodeJS.ProcessEnv = process.env): RateLimitConfig {
  return {
    pair_per_min: numEnv(env.HUB_RATELIMIT_PAIR_PER_MIN, DEFAULT_RATE_LIMIT.pair_per_min),
    pair_refresh_per_min: numEnv(env.HUB_RATELIMIT_PAIR_REFRESH_PER_MIN, DEFAULT_RATE_LIMIT.pair_refresh_per_min),
    ws_daemon_per_min: numEnv(env.HUB_RATELIMIT_WS_DAEMON_PER_MIN, DEFAULT_RATE_LIMIT.ws_daemon_per_min),
  };
}

function numEnv(v: string | undefined, def: number): number {
  if (v === undefined || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

export class RateLimiter {
  private readonly windows = new Map<string, number[]>();
  private lastGc = Date.now();

  constructor(private readonly windowMs = 60_000) {}

  // Returns true if the request is allowed; false if it exceeded the limit.
  // limit <= 0 disables the check (used to opt out of rate-limiting via env=0).
  check(key: string, limit: number, now: number = Date.now()): boolean {
    if (limit <= 0) return true;
    const cutoff = now - this.windowMs;
    let arr = this.windows.get(key);
    if (!arr) { arr = []; this.windows.set(key, arr); }
    // Trim out-of-window entries from the front.
    let i = 0;
    while (i < arr.length && arr[i]! < cutoff) i++;
    if (i > 0) arr.splice(0, i);
    if (arr.length >= limit) return false;
    arr.push(now);
    if (now - this.lastGc > this.windowMs) this.gc(now);
    return true;
  }

  private gc(now: number): void {
    const cutoff = now - this.windowMs;
    for (const [k, arr] of this.windows) {
      while (arr.length && arr[0]! < cutoff) arr.shift();
      if (arr.length === 0) this.windows.delete(k);
    }
    this.lastGc = now;
  }
}
