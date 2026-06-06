import type { PwaAgentHandshake } from "@cc-remote/proto";
import { eventKey, type HubState } from "./useHub";

/**
 * Pure selector — no React hook, just reads from a HubState slice.
 * Mirrors the shape of `selectSlashInventory` so callers using both
 * read consistently from the same store.
 *
 * Returns `null` when no `agent_handshake` frame has arrived yet for
 * the (daemon_id, session_id) pair. Callers should render a placeholder
 * (e.g. "—") rather than a spinner — the frame is push-based, not RPC.
 */
export function selectAgentCapabilities(
  state: Pick<HubState, "agentHandshakes">,
  daemon_id: string,
  session_id: string,
): PwaAgentHandshake | null {
  return state.agentHandshakes[eventKey(daemon_id, session_id)] ?? null;
}
