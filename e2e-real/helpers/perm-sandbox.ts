// Helper for permission-scenario sandboxes — pre-creates files in a tmp dir
// so the prompt has a stable target the LLM cannot wander away from.

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface PermSandbox {
  dir: string;
  files: string[];
  cleanup(): void;
}

export function setupPermSandbox(scenario: string, fileCount = 1): PermSandbox {
  const dir = join(tmpdir(), `ccr-perm-${scenario}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  for (let i = 1; i <= fileCount; i++) {
    const p = join(dir, `f${i}.txt`);
    writeFileSync(p, `cc-remote test sandbox file ${i}\n`);
    files.push(p);
  }
  return {
    dir, files,
    cleanup() {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}
