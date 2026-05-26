import type { SlashEntry } from "@cc-remote/proto";
import { eventKey, type HubState } from "./useHub";

/**
 * Pure selector — no React hook, just reads from a HubState slice. Components
 * call this with the state they already own (passed via props or context),
 * keeping it testable without a render.
 */
export function selectSlashInventory(
  state: Pick<HubState, "slashInventory">,
  daemon_id: string,
  session_id: string,
): SlashEntry[] {
  return state.slashInventory[eventKey(daemon_id, session_id)] ?? [];
}
