import { test, expect } from "bun:test";
import {
  pushPrefsUrl,
  isPushPrefEnabled,
  togglePref,
  type PushPreferences,
} from "../src/hooks/usePushPrefs";

test("pushPrefsUrl converts ws→http", () => {
  expect(pushPrefsUrl("ws://hub:7745")).toBe("http://hub:7745/push/preferences");
  expect(pushPrefsUrl("wss://hub")).toBe("https://hub/push/preferences");
});

test("isPushPrefEnabled treats 'permission' as default-true", () => {
  expect(isPushPrefEnabled({}, "permission")).toBe(true);
  expect(isPushPrefEnabled({ permission: false }, "permission")).toBe(false);
  expect(isPushPrefEnabled({ permission: true }, "permission")).toBe(true);
});

test("isPushPrefEnabled treats other keys as default-false", () => {
  expect(isPushPrefEnabled({}, "offline")).toBe(false);
  expect(isPushPrefEnabled({ offline: true }, "offline")).toBe(true);
  expect(isPushPrefEnabled({ offline: false }, "offline")).toBe(false);
});

test("togglePref flips a default-true key", () => {
  const before: PushPreferences = {};
  const after = togglePref(before, "permission");
  expect(after.permission).toBe(false);
  expect(togglePref(after, "permission").permission).toBe(true);
});

test("togglePref flips a default-false key", () => {
  const before: PushPreferences = { offline: false };
  expect(togglePref(before, "offline").offline).toBe(true);
});

test("togglePref does not mutate input", () => {
  const before: PushPreferences = { offline: false };
  togglePref(before, "offline");
  expect(before.offline).toBe(false);
});
