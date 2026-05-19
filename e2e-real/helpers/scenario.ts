// Shared scenario helper — pairs a daemon and starts it in one step.
// Encapsulates the "issue code → mkStateDir → pairDaemon → startDaemon"
// dance that every scenario repeats.

import { issuePairingCode } from "./admin.ts";
import { startDaemon, pairDaemon, mkStateDir, rmStateDir, type DaemonOpts, type DaemonHandle } from "./daemon.ts";

export interface PairAndStartOpts extends Omit<DaemonOpts, "state_dir"> {
  hub_http: string;     // e.g. http://localhost:7745
  hub_url: string;      // e.g. ws://localhost:7745
  owner_sub?: string;
}

export interface PairedDaemonHandle extends DaemonHandle {
  cleanup(): Promise<void>;
}

export async function pairAndStartDaemon(opts: PairAndStartOpts): Promise<PairedDaemonHandle> {
  const code = issuePairingCode(opts.daemon_id, opts.owner_sub);
  const state_dir = mkStateDir(opts.daemon_id);
  pairDaemon({ state_dir, hub_url: opts.hub_http, code, daemon_id: opts.daemon_id });
  const handle = await startDaemon({
    ...opts,
    state_dir,
  });
  return {
    ...handle,
    async cleanup() {
      await handle.stop();
      rmStateDir(state_dir);
    },
  };
}
