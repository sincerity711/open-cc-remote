import { watch, mkdirSync, existsSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface BindJsonlInput {
  dir: string;
  registerTimeMs: number;
  timeoutMs: number;
}

const UUID_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

// Watches `dir` for the first .jsonl file whose mtime is at or after
// (registerTimeMs - 2000ms) — small back-skew tolerance for clock and
// fs.watch event ordering. Resolves with the basename UUID, or null on timeout.
export async function bindJsonl({ dir, registerTimeMs, timeoutMs }: BindJsonlInput): Promise<string | null> {
  if (!existsSync(dir)) {
    try { mkdirSync(dir, { recursive: true }); } catch {}
  }

  const back = registerTimeMs - 2000;

  // Pre-scan: in case a JSONL was already created moments before register.
  for (const entry of readdirSync(dir)) {
    const m = UUID_RE.exec(entry);
    if (!m) continue;
    let mtime: number;
    try { mtime = statSync(join(dir, entry)).mtimeMs; } catch { continue; }
    if (mtime >= back) return m[1].toLowerCase();
  }

  return await new Promise<string | null>((resolve) => {
    let done = false;
    const finish = (id: string | null) => {
      if (done) return;
      done = true;
      try { watcher.close(); } catch {}
      clearTimeout(timer);
      resolve(id);
    };

    const watcher = watch(dir, { persistent: false }, (_event, filename) => {
      if (!filename) return;
      const m = UUID_RE.exec(filename);
      if (!m) return;
      let mtime: number;
      try { mtime = statSync(join(dir, filename)).mtimeMs; } catch { return; }
      if (mtime >= back) finish(m[1].toLowerCase());
    });
    watcher.on("error", () => finish(null));
    const timer = setTimeout(() => finish(null), timeoutMs);
  });
}
