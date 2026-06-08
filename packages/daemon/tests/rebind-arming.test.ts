import { test, expect } from "bun:test";
import { createRebindArming, shouldArmForCommand } from "../src/rebind-arming.ts";

// A minimal fake setTimeout/clearTimeout that never fires on its own — we
// drive the clock manually in TTL tests by capturing the queued callback.
function makeFakeTimers() {
  let queued: { id: number; fn: () => void } | null = null;
  let nextId = 1;
  const setT = ((fn: () => void): number => {
    const id = nextId++;
    queued = { id, fn };
    return id as unknown as number;
  }) as unknown as typeof setTimeout;
  const clearT = ((id: number) => {
    if (queued && queued.id === id) queued = null;
  }) as unknown as typeof clearTimeout;
  const fire = () => {
    const q = queued;
    queued = null;
    if (q) q.fn();
  };
  const isPending = () => queued !== null;
  return { setT, clearT, fire, isPending };
}

test("arm/isArmed/disarm — basic round trip", () => {
  const { setT, clearT } = makeFakeTimers();
  const arming = createRebindArming({ setTimeoutFn: setT, clearTimeoutFn: clearT });
  expect(arming.isArmed("s1")).toBe(false);
  arming.arm("s1");
  expect(arming.isArmed("s1")).toBe(true);
  arming.disarm("s1");
  expect(arming.isArmed("s1")).toBe(false);
});

test("arm is per-session — arming one does not affect another", () => {
  const { setT, clearT } = makeFakeTimers();
  const arming = createRebindArming({ setTimeoutFn: setT, clearTimeoutFn: clearT });
  arming.arm("s1");
  expect(arming.isArmed("s2")).toBe(false);
  expect(arming.isArmed("s1")).toBe(true);
});

test("disarm on un-armed session is a no-op", () => {
  const { setT, clearT } = makeFakeTimers();
  const arming = createRebindArming({ setTimeoutFn: setT, clearTimeoutFn: clearT });
  expect(() => arming.disarm("never-armed")).not.toThrow();
  expect(arming.isArmed("never-armed")).toBe(false);
});

test("re-arm clears the previous timer (no double-disarm)", () => {
  const { setT, clearT, isPending } = makeFakeTimers();
  const arming = createRebindArming({ setTimeoutFn: setT, clearTimeoutFn: clearT });
  arming.arm("s1");
  expect(isPending()).toBe(true);
  arming.arm("s1"); // should clear+replace
  expect(isPending()).toBe(true); // still exactly one
  expect(arming.isArmed("s1")).toBe(true);
});

test("ttl auto-disarms when timer fires", () => {
  const { setT, clearT, fire } = makeFakeTimers();
  const arming = createRebindArming({ setTimeoutFn: setT, clearTimeoutFn: clearT, ttlMs: 1 });
  arming.arm("s1");
  expect(arming.isArmed("s1")).toBe(true);
  fire(); // simulate ttl elapsing
  expect(arming.isArmed("s1")).toBe(false);
});

test("shouldArmForCommand — /clear and variants", () => {
  expect(shouldArmForCommand("/clear")).toBe(true);
  expect(shouldArmForCommand("  /clear  ")).toBe(true);
  expect(shouldArmForCommand("/clear something")).toBe(true);
});

test("shouldArmForCommand — /compact and dash-suffixed variants", () => {
  expect(shouldArmForCommand("/compact")).toBe(true);
  expect(shouldArmForCommand("/compact some-mode")).toBe(true);
  expect(shouldArmForCommand("/compact-aggressive")).toBe(true);
});

test("shouldArmForCommand — non-rotating commands return false", () => {
  expect(shouldArmForCommand("/help")).toBe(false);
  expect(shouldArmForCommand("/model claude-opus")).toBe(false);
  expect(shouldArmForCommand("hi there")).toBe(false);
  expect(shouldArmForCommand("")).toBe(false);
  expect(shouldArmForCommand("/")).toBe(false);
});

test("shouldArmForCommand — does NOT match prefix collision /clearall", () => {
  // /clearall is hypothetical, but our token-based match must not fire.
  expect(shouldArmForCommand("/clearall")).toBe(false);
});
