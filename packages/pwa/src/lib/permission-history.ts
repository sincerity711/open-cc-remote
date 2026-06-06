import type {
  PwaPermissionRequest,
  PwaAskUserQuestionRequest,
} from "@cc-remote/proto";

/**
 * Sticky LRU caches for resolved-card lookup.
 *
 * Why:
 *   - The hub's `pendingPermissions` / `pendingQuestions` slices are cleared
 *     the moment a `*_resolved` frame arrives (see useHub.ts), so a card
 *     rendered for the resolved frame can no longer recover the original
 *     request payload (tool, args_summary, options …) from those slices.
 *   - `BufferedEvent.event` only carries AG-UI events, not protocol frames,
 *     so walking the events buffer doesn't help either.
 *
 * The fix: a separate cache populated on `*_request` and **never cleared on
 * resolve**, bounded so memory stays flat in long sessions. We also retain
 * the local PWA submission's `answers` payload because the resolved frame
 * over the wire does not echo it (`PwaAskUserQuestionResolved` carries only
 * a resolution enum). Cross-device PWAs that didn't submit locally hit a
 * placeholder.
 *
 * LRU bound: 64 entries per cache. Sessions with >64 permission/ask prompts
 * are pathological; oldest entries fall back to "(not in history)" body.
 */
export const PERMISSION_HISTORY_LRU_MAX = 64;

/**
 * Insert into a string-keyed map with LRU eviction. ES2015 guarantees
 * own-string-key insertion order is preserved, so re-setting a key is
 * implemented as delete+set so the touched key bumps to "newest". Once
 * the map exceeds `max`, the oldest keys are dropped until size === max.
 *
 * Returns a new map (immutable update). Safe for React reducer use.
 */
export function insertWithLru<V>(
  history: Record<string, V>,
  key: string,
  value: V,
  max: number = PERMISSION_HISTORY_LRU_MAX,
): Record<string, V> {
  const next: Record<string, V> = { ...history };
  if (key in next) delete next[key];
  next[key] = value;
  const keys = Object.keys(next);
  if (keys.length <= max) return next;
  for (let i = 0; i < keys.length - max; i++) {
    delete next[keys[i]!];
  }
  return next;
}

export function findPermissionRequest(
  history: Record<string, PwaPermissionRequest>,
  requestId: string,
): PwaPermissionRequest | null {
  return history[requestId] ?? null;
}

export function findAskQuestionRequest(
  history: Record<string, PwaAskUserQuestionRequest>,
  requestId: string,
): PwaAskUserQuestionRequest | null {
  return history[requestId] ?? null;
}

export function findAskQuestionAnswers(
  history: Record<string, (string | null)[]>,
  requestId: string,
): (string | null)[] | null {
  return history[requestId] ?? null;
}
