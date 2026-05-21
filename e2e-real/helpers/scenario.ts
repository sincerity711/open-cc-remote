// Shared scenario helper — pairs a daemon and starts it in one step.
// Encapsulates the "issue code → mkStateDir → pairDaemon → startDaemon"
// dance that every scenario repeats.

import type { Page } from "@playwright/test";
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

export interface ScenarioContext {
  page: Page;
  artifactsDir: string;
  scenarioSlug: string;
  projectName: string;
  step: (label: string, fn: () => Promise<void>) => Promise<void>;
}

export function makeScenarioContext(opts: {
  page: Page;
  artifactsDir: string;
  scenarioSlug: string;
  projectName: string;
}): ScenarioContext {
  let seq = 0;
  return {
    page: opts.page,
    artifactsDir: opts.artifactsDir,
    scenarioSlug: opts.scenarioSlug,
    projectName: opts.projectName,
    step: async (label, fn) => {
      seq += 1;
      await fn();
      const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      const padded = String(seq).padStart(2, "0");
      const file = `${opts.artifactsDir}/${padded}-${slug}.${opts.projectName}.png`;
      await opts.page.screenshot({ path: file, fullPage: false });
    },
  };
}
