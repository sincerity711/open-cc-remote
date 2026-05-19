// Admin helpers for e2e-real tests. Wraps `cc-remote` admin commands run inside
// the dockerized hub container.

import { execHubCmd } from "./compose.ts";

export function issuePairingCode(daemon_id: string, owner_sub = "i060912@sap.com"): string {
  const out = execHubCmd([
    "bun", "run", "/app/packages/hub/src/admin.ts",
    "issue-pairing-code", owner_sub, daemon_id,
  ]);
  return out.trim();
}
