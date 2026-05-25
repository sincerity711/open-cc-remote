import type { ToolCallResultEvent } from "@cc-remote/proto";

export type ToolStatus = "success" | "failure";

const ERROR_HEURISTIC = /^(Error|ERROR|error)\b|exit code [^0]|<error/;

/**
 * Decide whether a tool call succeeded or failed.
 *
 * Priority:
 *   1. rawEvent.is_error (set by adapters that have structured failure info,
 *      e.g. Claude Code's tool_result.is_error). This is the authoritative
 *      project convention per spec decision #7.
 *   2. Content heuristic — looks for common error markers in the output text.
 *      Used when an adapter doesn't carry structured failure info.
 */
export function toolStatusFromResult(ev: ToolCallResultEvent): ToolStatus {
  const raw = (ev as { rawEvent?: { is_error?: unknown } }).rawEvent;
  if (raw && typeof raw.is_error === "boolean") {
    return raw.is_error ? "failure" : "success";
  }
  return ERROR_HEURISTIC.test(ev.content ?? "") ? "failure" : "success";
}

export function formatDuration(start: number | undefined, end: number | undefined): string {
  if (start === undefined || end === undefined) return "";
  const ms = Math.max(0, end - start);
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

export function riskFromToolName(name: string): "warning" | undefined {
  if (name === "Bash" || name === "Edit" || name === "Write" || name === "MultiEdit") {
    return "warning";
  }
  return undefined;
}
