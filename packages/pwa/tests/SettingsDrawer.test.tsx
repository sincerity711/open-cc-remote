import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DeviceItem } from "../src/hooks/useDevices";
import { SettingsDrawer } from "../src/screens/SettingsDrawer";

const devices: DeviceItem[] = [
  { device_id: "dev-1", display_name: "MacBook", paired_at: 0, last_seen_at: 0 },
  { device_id: "dev-2", display_name: null, paired_at: 0, last_seen_at: null },
];

test("SettingsDrawer renders all five sections with live data", () => {
  const markup = renderToStaticMarkup(
    <SettingsDrawer
      device="desktop"
      account={{ email: "alice@example.com", onSignOut: () => {} }}
      devices={devices}
      onRenameDevice={() => {}}
      onRevokeDevice={() => {}}
      pushPrefs={{ permission: true, offline: false, completed: true, idle: false }}
      onTogglePref={() => {}}
      appearance="system"
      onSetAppearance={() => {}}
      error={null}
      onClose={() => {}}
    />,
  );

  expect(markup).toContain("alice@example.com");
  expect(markup).toContain("MacBook");
  expect(markup).toContain("(unnamed)");
  expect(markup).toContain("Permission alerts");
  expect(markup).toContain("Daemon offline");
  expect(markup).toContain("Claude finished a turn");
  expect(markup).toContain("Claude is idle");
  // Permission default-on + completed=true → two On chips.
  expect((markup.match(/>On</g) ?? []).length).toBe(2);
  expect((markup.match(/>Off</g) ?? []).length).toBe(2);
  expect(markup).toContain("Run cc-remote pair on your machine");
  expect(markup).toContain("Copy command");
});

test("SettingsDrawer surfaces error inline", () => {
  const markup = renderToStaticMarkup(
    <SettingsDrawer
      device="mobile"
      account={{ email: "x@y", onSignOut: () => {} }}
      devices={null}
      onRenameDevice={() => {}}
      onRevokeDevice={() => {}}
      pushPrefs={null}
      onTogglePref={() => {}}
      appearance="light"
      onSetAppearance={() => {}}
      error="failed to fetch devices"
      onClose={() => {}}
    />,
  );
  expect(markup).toContain("failed to fetch devices");
});
