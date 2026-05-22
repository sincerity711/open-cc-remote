import { watch, mkdirSync, existsSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface BindJsonlInput {
  dir: string;
  registerTimeMs: number;
  /**
   * Optional abort signal. Aborting resolves the promise with `null` and
   * releases the fs watcher. When omitted, the watcher runs until a JSONL
   * file matching the mtime threshold appears OR the daemon process exits.
   * Tests pass `AbortSignal.timeout(ms)` for deterministic resolution.
   */
  signal?: AbortSignal;
  /** @deprecated use `signal: AbortSignal.timeout(ms)`. Still honored for
   * backwards compat with existing test call sites. */
  timeoutMs?: number;
}

const JSONL_RE = /^(.+)\.jsonl$/;

// Watches `dir` for the first .jsonl file whose mtime is at or after
// (registerTimeMs - 2000ms) — small back-skew tolerance for clock and
// fs.watch event ordering. Resolves with the basename (without .jsonl
// extension), or null on abort. Real Claude Code names these files with
// a session UUID; tests sometimes use shorter ids (e.g., "s_e2e_tx").
//
// This was historically a 30s polling bind, which broke the demo path
// (user opens the PWA, registers, then takes minutes to type a prompt).
// The watcher is now indefinite — bound only by the daemon process
// lifetime or an explicit AbortSignal.
export async function bindJsonl({ dir, registerTimeMs, signal, timeoutMs }: BindJsonlInput): Promise<string | null> {
  if (!existsSync(dir)) {
    try { mkdirSync(dir, { recursive: true }); } catch {}
  }

  const back = registerTimeMs - 2000;

  // Pre-scan: in case a JSONL was already created moments before register.
  for (const entry of readdirSync(dir)) {
    const m = JSONL_RE.exec(entry);
    if (!m || !m[1]) continue;
    let mtime: number;
    try { mtime = statSync(join(dir, entry)).mtimeMs; } catch { continue; }
    if (mtime >= back) return m[1];
  }

  return await new Promise<string | null>((resolve) => {
    let done = false;
    const finish = (id: string | null) => {
      if (done) return;
      done = true;
      try { watcher.close(); } catch {}
      signal?.removeEventListener("abort", onAbort);
      if (timer) clearTimeout(timer);
      resolve(id);
    };

    const onAbort = () => finish(null);
    if (signal) {
      if (signal.aborted) { resolve(null); return; }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    const timer = timeoutMs && timeoutMs > 0
      ? setTimeout(() => finish(null), timeoutMs)
      : null;

    const watcher = watch(dir, { persistent: false }, (_event, filename) => {
      if (!filename) return;
      const m = JSONL_RE.exec(filename);
      if (!m || !m[1]) return;
      let mtime: number;
      try { mtime = statSync(join(dir, filename)).mtimeMs; } catch { return; }
      if (mtime >= back) finish(m[1]);
    });
    watcher.on("error", () => finish(null));
  });
}
