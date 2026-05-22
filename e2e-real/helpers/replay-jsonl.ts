// Replay a JSONL "tape" by appending each line (with a newline) to the
// daemon's session JSONL path, with a configurable per-line delay.
//
// The daemon's JSONL bind algorithm (see packages/daemon/src/jsonl-bind.ts)
// requires the .jsonl FILE to exist (or the parent dir) before the watcher
// can attach. Tests should follow the e2e/transcript.test.ts pattern:
//
//   import { mkdirSync, writeFileSync } from "node:fs";
//   const sessionDir = join(projectsDir, encodeCwd(sessionCwd));
//   mkdirSync(sessionDir, { recursive: true });
//   const jsonlPath = join(sessionDir, `${sessionId}.jsonl`);
//   writeFileSync(jsonlPath, ""); // touch — bind picks this up
//
// THEN call `replayJsonlTape({ jsonlPath, tapePath })` to stream lines.
//
// `lineDelayMs` simulates streaming so the timeline merge has time to flush
// renders between lines (matches real Claude pacing: ~50–500ms between
// assistant chunks).

import { appendFileSync, readFileSync } from "node:fs";

export interface ReplayOpts {
  /** File the daemon is watching (e.g. `<projectsDir>/<encodeCwd(cwd)>/<sessionId>.jsonl`). */
  jsonlPath: string;
  /** Path to the .jsonl fixture under e2e-real/fixtures/jsonl-tapes/. */
  tapePath: string;
  /** Delay between lines, ms. Default 50. */
  lineDelayMs?: number;
  /** Skip the first N lines of the tape. Default 0. */
  startOffset?: number;
}

export async function replayJsonlTape(opts: ReplayOpts): Promise<void> {
  const lineDelayMs = opts.lineDelayMs ?? 50;
  const startOffset = opts.startOffset ?? 0;

  const tapeText = readFileSync(opts.tapePath, "utf8");
  const lines = tapeText.split("\n").filter((l) => l.length > 0);

  for (let i = startOffset; i < lines.length; i++) {
    appendFileSync(opts.jsonlPath, `${lines[i]}\n`);
    if (i < lines.length - 1 && lineDelayMs > 0) {
      await new Promise((r) => setTimeout(r, lineDelayMs));
    }
  }
}
