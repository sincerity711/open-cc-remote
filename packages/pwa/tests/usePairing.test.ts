import { test, expect } from "bun:test";
import { pairIssueUrl, pairingTick, type PairingState } from "../src/hooks/usePairing";

test("pairIssueUrl converts ws→http", () => {
  expect(pairIssueUrl("ws://hub:7745")).toBe("http://hub:7745/pair/issue");
  expect(pairIssueUrl("wss://hub")).toBe("https://hub/pair/issue");
});

test("pairingTick decrements remainingSec while time remains", () => {
  const state: PairingState = { status: "active", code: "ABC-XYZ", expiresAt: 10_000, remainingSec: 10 };
  const next = pairingTick(state, 3_000);
  expect(next).toEqual({
    state: { status: "active", code: "ABC-XYZ", expiresAt: 10_000, remainingSec: 7 },
    expired: false,
  });
});

test("pairingTick returns idle + expired=true at exactly expiresAt", () => {
  const state: PairingState = { status: "active", code: "ABC-XYZ", expiresAt: 10_000, remainingSec: 1 };
  const next = pairingTick(state, 10_000);
  expect(next).toEqual({ state: { status: "idle" }, expired: true });
});

test("pairingTick returns idle + expired=true when now is past expiresAt", () => {
  const state: PairingState = { status: "active", code: "ABC-XYZ", expiresAt: 10_000, remainingSec: 1 };
  const next = pairingTick(state, 12_000);
  expect(next).toEqual({ state: { status: "idle" }, expired: true });
});

test("pairingTick on non-active state is a no-op", () => {
  expect(pairingTick({ status: "idle" }, 1000)).toEqual({ state: { status: "idle" }, expired: false });
  expect(pairingTick({ status: "issuing" }, 1000)).toEqual({ state: { status: "issuing" }, expired: false });
});

test("pairingTick rounds up sub-second remainders", () => {
  const state: PairingState = { status: "active", code: "ABC-XYZ", expiresAt: 10_000, remainingSec: 1 };
  const next = pairingTick(state, 9_500);
  if (next.state.status !== "active") throw new Error("expected active");
  expect(next.state.remainingSec).toBe(1);
});
