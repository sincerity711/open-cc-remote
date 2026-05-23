import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DaemonItem } from "../src/hooks/useDaemons";
import type { PushPreferences } from "../src/hooks/usePushPrefs";
import type { PairingState } from "../src/hooks/usePairing";
import type { Resource } from "../src/hooks/types";
import { SettingsDrawer } from "../src/screens/SettingsDrawer";

const baseProps = {
  device: "desktop" as const,
  account: { email: "alice@example.com", onSignOut: () => {} },
  onRenameDaemon: () => {},
  onRevokeDaemon: () => {},
  onTogglePref: () => {},
  onGenerateCode: () => {},
  onCancelPairing: () => {},
  appearance: "system" as const,
  onSetAppearance: () => {},
  onClose: () => {},
};

const readyDaemons: Resource<DaemonItem[]> = {
  status: "ready",
  data: [
    { daemon_id: "d1", display_name: "Work laptop", hostname: "mbp", paired_at: 0, last_seen_at: Date.now(), connected: true },
    { daemon_id: "d2", display_name: null, hostname: null, paired_at: 0, last_seen_at: null, connected: false },
  ],
};
const readyPrefs: Resource<PushPreferences> = {
  status: "ready", data: { permission: true, offline: false, completed: true, idle: false },
};
const idlePairing: PairingState = { status: "idle" };

test("renders all sections with ready data", () => {
  const markup = renderToStaticMarkup(
    <SettingsDrawer
      {...baseProps}
      daemons={readyDaemons}
      pushPrefs={readyPrefs}
      pairing={idlePairing}
    />,
  );
  expect(markup).toContain("alice@example.com");
  expect(markup).toContain("Work laptop");
  expect(markup).toContain("Online");
  expect(markup).toContain("Never connected");
  expect(markup).toContain("Permission alerts");
  expect(markup).toContain("Generate code");
  expect(markup).toContain("Run cc-remote pair on your machine");
});

test("daemons section shows loading", () => {
  const markup = renderToStaticMarkup(
    <SettingsDrawer
      {...baseProps}
      daemons={{ status: "loading" }}
      pushPrefs={readyPrefs}
      pairing={idlePairing}
    />,
  );
  expect(markup.match(/Loading…/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
});

test("daemons section shows error with retry button", () => {
  const markup = renderToStaticMarkup(
    <SettingsDrawer
      {...baseProps}
      daemons={{ status: "error", error: "boom", retry: () => {} }}
      pushPrefs={readyPrefs}
      pairing={idlePairing}
    />,
  );
  expect(markup).toContain("Couldn't load");
  expect(markup).toContain("Retry");
});

test("pair-code active state shows code and copy command", () => {
  const markup = renderToStaticMarkup(
    <SettingsDrawer
      {...baseProps}
      daemons={readyDaemons}
      pushPrefs={readyPrefs}
      pairing={{ status: "active", code: "ABC-XYZ", expiresAt: Date.now() + 60_000, remainingSec: 60 }}
    />,
  );
  expect(markup).toContain("ABC-XYZ");
  expect(markup).toContain("cc-remote pair ABC-XYZ");
  expect(markup).toContain("Cancel");
});

test("does not render top-level error banner anymore", () => {
  const markup = renderToStaticMarkup(
    <SettingsDrawer
      {...baseProps}
      daemons={{ status: "error", error: "boom", retry: () => {} }}
      pushPrefs={{ status: "error", error: "boom", retry: () => {} }}
      pairing={idlePairing}
    />,
  );
  expect(markup).not.toContain("bg-danger-subtle");
});
