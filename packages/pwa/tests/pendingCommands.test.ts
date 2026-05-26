import { test, expect } from "bun:test";
import {
  createPending, confirmPending, failPending, timeoutPending,
  type PendingCommand, type PendingCommandKind,
} from "../src/hooks/pendingCommands";

const baseInput = (over: Partial<PendingCommand>): PendingCommand => ({
  id: "id-1",
  kind: "chat_send" as PendingCommandKind,
  daemon_id: "d",
  status: "pending",
  started_at: 1_700_000_000_000,
  ...over,
});

test("createPending adds entry keyed by id", () => {
  const out = createPending({}, baseInput({}));
  expect(out["id-1"]?.status).toBe("pending");
  expect(out["id-1"]?.kind).toBe("chat_send");
});

test("confirmPending removes entry", () => {
  const start = createPending({}, baseInput({}));
  const out = confirmPending(start, "id-1");
  expect(out["id-1"]).toBeUndefined();
});

test("confirmPending returns same reference if id missing", () => {
  const start = createPending({}, baseInput({}));
  const out = confirmPending(start, "missing");
  expect(out).toBe(start);
});

test("failPending marks status=failed and stores error", () => {
  const start = createPending({}, baseInput({}));
  const out = failPending(start, "id-1", "boom");
  expect(out["id-1"]?.status).toBe("failed");
  expect(out["id-1"]?.error).toBe("boom");
});

test("timeoutPending marks status=timed_out", () => {
  const start = createPending({}, baseInput({}));
  const out = timeoutPending(start, "id-1");
  expect(out["id-1"]?.status).toBe("timed_out");
});

test("transitions ignore already-resolved entries", () => {
  const start = createPending({}, baseInput({ status: "failed" }));
  const out = timeoutPending(start, "id-1");
  expect(out["id-1"]?.status).toBe("failed");
});
