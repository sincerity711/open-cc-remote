export type PendingCommandKind =
  | "chat_send"
  | "start_session"
  | "request_history"
  | "permission_reply"
  | "kill_session";

export type PendingCommandStatus = "pending" | "failed" | "timed_out";

export interface PendingCommand {
  id: string;
  kind: PendingCommandKind;
  daemon_id: string;
  session_id?: string;
  started_at: number;
  status: PendingCommandStatus;
  label?: string;
  error?: string;
}

export type PendingCommands = Record<string, PendingCommand>;

export function createPending(
  prev: PendingCommands,
  cmd: PendingCommand,
): PendingCommands {
  return { ...prev, [cmd.id]: cmd };
}

export function confirmPending(
  prev: PendingCommands,
  id: string,
): PendingCommands {
  if (!prev[id]) return prev;
  const next = { ...prev };
  delete next[id];
  return next;
}

export function failPending(
  prev: PendingCommands,
  id: string,
  error: string,
): PendingCommands {
  const cur = prev[id];
  if (!cur || cur.status !== "pending") return prev;
  return { ...prev, [id]: { ...cur, status: "failed", error } };
}

export function timeoutPending(
  prev: PendingCommands,
  id: string,
): PendingCommands {
  const cur = prev[id];
  if (!cur || cur.status !== "pending") return prev;
  return { ...prev, [id]: { ...cur, status: "timed_out" } };
}

export function dismissPending(
  prev: PendingCommands,
  id: string,
): PendingCommands {
  return confirmPending(prev, id);
}

export function findPending(
  pending: PendingCommands,
  predicate: (cmd: PendingCommand) => boolean,
): PendingCommand | undefined {
  for (const v of Object.values(pending)) {
    if (predicate(v)) return v;
  }
  return undefined;
}
