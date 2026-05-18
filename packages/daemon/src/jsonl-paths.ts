import { homedir } from "node:os";
import { join } from "node:path";

export function encodeCwd(cwd: string): string {
  // Trim trailing slashes (except keep at least one char for "/" → "-").
  const trimmed = cwd.replace(/\/+$/, "") || "/";
  return trimmed.replace(/\//g, "-");
}

export function projectsDir(): string {
  return process.env.CLAUDE_PROJECTS_DIR ?? join(homedir(), ".claude", "projects");
}

export function jsonlPath(cwd: string, session_id: string): string {
  return join(projectsDir(), encodeCwd(cwd), `${session_id}.jsonl`);
}
