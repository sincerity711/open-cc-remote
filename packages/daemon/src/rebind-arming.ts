/**
 * Per-session "armed for rebind" bit.
 *
 * The daemon watches each session's projects dir for new `.jsonl` files —
 * because Claude Code rotates its session id (and thus opens a new jsonl)
 * on `/clear`, `/compact*`, and `--resume`. Without rebinding, our event
 * watcher keeps reading the old, now-frozen file.
 *
 * History: the watcher used to rebind unconditionally on any new jsonl with
 * a recent mtime. That broke when a SECOND, unrelated `claude` ran in the
 * same cwd (e.g. the user's hand-attached tmux session) — daemon would
 * ping-pong between the two files forever.
 *
 * Fix: only rebind when *we* know a rotate is incoming. The gate is
 * armed by `handleCliCommand` when the PWA submits a slash command that
 * is known to rotate (see ROTATING_SLASH_COMMANDS). The gate is fired
 * (and disarmed) by the next jsonl write the watcher sees within a
 * reasonable window. Disarm-on-fire is required so a SECOND new file
 * appearing later (e.g. unrelated claude in same cwd) does NOT cause a
 * rebind. A TTL also disarms in case the rotate never lands.
 *
 * Out of scope: a user typing `/clear` directly into the attached tmux
 * (bypassing cli_command) won't arm the gate, and the daemon will keep
 * the old file bound. Acceptable degradation — the recovery is "PWA
 * submits the same slash command" or "kill+recreate the session".
 */

export interface RebindArming {
  arm(session_id: string): void;
  isArmed(session_id: string): boolean;
  disarm(session_id: string): void;
}

export interface CreateRebindArmingOpts {
  /** Auto-disarm after this many ms if no rebind fires. Default 30s. */
  ttlMs?: number;
  /** Injectable for tests. */
  setTimeoutFn?: typeof setTimeout;
  /** Injectable for tests. */
  clearTimeoutFn?: typeof clearTimeout;
  /** Injectable for tests / observability. */
  log?: (msg: string) => void;
}

export function createRebindArming(opts: CreateRebindArmingOpts = {}): RebindArming {
  const ttlMs = opts.ttlMs ?? 30_000;
  const setT = opts.setTimeoutFn ?? setTimeout;
  const clearT = opts.clearTimeoutFn ?? clearTimeout;
  const log = opts.log ?? (() => {});

  // session_id → expiry timer handle. Presence of an entry == armed.
  const armed = new Map<string, ReturnType<typeof setTimeout>>();

  return {
    arm(session_id) {
      const old = armed.get(session_id);
      if (old) clearT(old);
      const t = setT(() => {
        armed.delete(session_id);
        log(`rebind-arming: ttl elapsed for session=${session_id}`);
      }, ttlMs);
      armed.set(session_id, t);
      log(`rebind-arming: armed session=${session_id} ttl=${ttlMs}ms`);
    },
    isArmed(session_id) {
      return armed.has(session_id);
    },
    disarm(session_id) {
      const t = armed.get(session_id);
      if (!t) return;
      clearT(t);
      armed.delete(session_id);
      log(`rebind-arming: disarmed session=${session_id}`);
    },
  };
}

/**
 * Slash commands that cause Claude Code to rotate its sessionId / open a new
 * jsonl. Anything else (e.g. `/help`, `/model`) should NOT arm the gate.
 *
 * Match is on the FIRST whitespace-delimited token so `/compact some-args`
 * and `/clear`-no-args both work; we don't care about anything after.
 */
export const ROTATING_SLASH_COMMANDS: ReadonlySet<string> = new Set([
  "/clear",
  // /compact has variants like /compact-some-mode — match by prefix in
  // shouldArmForCommand below, not by exact set membership.
]);

const COMPACT_PREFIX = "/compact";

export function shouldArmForCommand(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return false;
  // First whitespace-delimited token (still preserving the leading `/`).
  const firstSpace = trimmed.search(/\s/);
  const head = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
  if (ROTATING_SLASH_COMMANDS.has(head)) return true;
  if (head === COMPACT_PREFIX || head.startsWith(`${COMPACT_PREFIX}-`)) return true;
  return false;
}
