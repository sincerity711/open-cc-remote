import { expect, test, describe } from "bun:test";
import { SessionFsm } from "../src/session-fsm";
import type { SessionState, AGUIEvent } from "@cc-remote/proto";
import { EventType } from "@cc-remote/proto";

interface Transition {
  session_id: string;
  state: SessionState;
  prev: SessionState;
}

function makeFsm(): { fsm: SessionFsm; transitions: Transition[] } {
  const fsm = new SessionFsm();
  const transitions: Transition[] = [];
  fsm.onTransition((session_id, state, prev) => transitions.push({ session_id, state, prev }));
  return { fsm, transitions };
}

test("register installs an idle session without emitting a transition", () => {
  const { fsm, transitions } = makeFsm();
  fsm.register("s1");
  expect(fsm.get("s1")).toBe("idle");
  expect(transitions).toEqual([]);
});

test("register is idempotent for the same session_id", () => {
  const { fsm, transitions } = makeFsm();
  fsm.register("s1");
  fsm.register("s1");
  expect(transitions).toEqual([]);
});

test("idle → working on first JSONL line", () => {
  const { fsm, transitions } = makeFsm();
  fsm.register("s1");
  fsm.onJsonlLine("s1");
  expect(fsm.get("s1")).toBe("working");
  expect(transitions).toEqual([{ session_id: "s1", state: "working", prev: "idle" }]);
});

test("subsequent JSONL lines while working do NOT emit duplicate transitions", () => {
  const { fsm, transitions } = makeFsm();
  fsm.register("s1");
  fsm.onJsonlLine("s1");
  fsm.onJsonlLine("s1");
  fsm.onJsonlLine("s1");
  expect(transitions).toHaveLength(1);
});

test("working → idle on idle timer", () => {
  const { fsm, transitions } = makeFsm();
  fsm.register("s1");
  fsm.onJsonlLine("s1");
  fsm.onIdleTimer("s1");
  expect(fsm.get("s1")).toBe("idle");
  expect(transitions.map((t) => t.state)).toEqual(["working", "idle"]);
});

test("idle → waiting on permission_request, returns to idle on resolve", () => {
  const { fsm, transitions } = makeFsm();
  fsm.register("s1");
  fsm.onPermissionRequest("s1");
  expect(fsm.get("s1")).toBe("waiting");
  fsm.onPermissionResolved("s1");
  expect(fsm.get("s1")).toBe("idle");
  expect(transitions.map((t) => `${t.prev}→${t.state}`)).toEqual([
    "idle→waiting",
    "waiting→idle",
  ]);
});

test("working → waiting on permission_request, returns to working on resolve", () => {
  const { fsm, transitions } = makeFsm();
  fsm.register("s1");
  fsm.onJsonlLine("s1");
  fsm.onPermissionRequest("s1");
  fsm.onPermissionResolved("s1");
  expect(fsm.get("s1")).toBe("working");
  expect(transitions.map((t) => `${t.prev}→${t.state}`)).toEqual([
    "idle→working",
    "working→waiting",
    "waiting→working",
  ]);
});

test("multiple concurrent permission_requests collapse to a single waiting state, resolve only on the last", () => {
  const { fsm, transitions } = makeFsm();
  fsm.register("s1");
  fsm.onJsonlLine("s1");
  fsm.onPermissionRequest("s1");
  fsm.onPermissionRequest("s1");
  fsm.onPermissionRequest("s1");
  expect(transitions.map((t) => t.state)).toEqual(["working", "waiting"]);
  fsm.onPermissionResolved("s1");
  fsm.onPermissionResolved("s1");
  // still waiting after 2/3 resolves
  expect(fsm.get("s1")).toBe("waiting");
  fsm.onPermissionResolved("s1");
  expect(fsm.get("s1")).toBe("working");
});

test("JSONL line during waiting upgrades the stashed prev to 'working' so resolve goes to working not idle", () => {
  const { fsm, transitions } = makeFsm();
  fsm.register("s1");
  // From idle, request permission first → waiting (stashed prev = idle)
  fsm.onPermissionRequest("s1");
  // Then a JSONL line arrives mid-permission. We can't transition out of
  // waiting, but we should remember activity so resolving brings us back
  // to working, not idle.
  fsm.onJsonlLine("s1");
  fsm.onPermissionResolved("s1");
  expect(fsm.get("s1")).toBe("working");
  expect(transitions.at(-1)).toEqual({ session_id: "s1", state: "working", prev: "waiting" });
});

test("idle timer firing during waiting demotes the stashed prev to 'idle'", () => {
  const { fsm, transitions } = makeFsm();
  fsm.register("s1");
  fsm.onJsonlLine("s1");                   // idle → working
  fsm.onPermissionRequest("s1");           // working → waiting (stashed=working)
  fsm.onIdleTimer("s1");                   // stays waiting, but stashed → idle
  fsm.onPermissionResolved("s1");
  expect(fsm.get("s1")).toBe("idle");
  expect(transitions.at(-1)).toEqual({ session_id: "s1", state: "idle", prev: "waiting" });
});

test("permission_request on an unregistered session lazily registers as waiting (with prev=idle)", () => {
  const { fsm, transitions } = makeFsm();
  fsm.onPermissionRequest("s-unknown");
  expect(fsm.get("s-unknown")).toBe("waiting");
  // First emitted transition should be idle→waiting (lazy register inserts as idle)
  expect(transitions[0]).toEqual({ session_id: "s-unknown", state: "waiting", prev: "idle" });
  fsm.onPermissionResolved("s-unknown");
  expect(fsm.get("s-unknown")).toBe("idle");
});

test("remove drops the entry; subsequent events on it are no-ops", () => {
  const { fsm, transitions } = makeFsm();
  fsm.register("s1");
  fsm.onJsonlLine("s1");
  fsm.remove("s1");
  fsm.onJsonlLine("s1");           // ignored
  fsm.onIdleTimer("s1");           // ignored
  fsm.onPermissionResolved("s1");  // ignored
  expect(fsm.get("s1")).toBeUndefined();
  // Only the original idle→working should have fired.
  expect(transitions).toHaveLength(1);
});

test("idle timer when already idle is a no-op (no duplicate transition)", () => {
  const { fsm, transitions } = makeFsm();
  fsm.register("s1");
  fsm.onIdleTimer("s1");
  fsm.onIdleTimer("s1");
  expect(transitions).toEqual([]);
});

test("permission_resolved without a prior request is a no-op (defensive)", () => {
  const { fsm, transitions } = makeFsm();
  fsm.register("s1");
  fsm.onPermissionResolved("s1");
  expect(fsm.get("s1")).toBe("idle");
  expect(transitions).toEqual([]);
});

test("multiple sessions are isolated", () => {
  const { fsm, transitions } = makeFsm();
  fsm.register("s1");
  fsm.register("s2");
  fsm.onJsonlLine("s1");           // s1 → working
  fsm.onPermissionRequest("s2");   // s2 → waiting
  expect(fsm.get("s1")).toBe("working");
  expect(fsm.get("s2")).toBe("waiting");
  expect(transitions).toEqual([
    { session_id: "s1", state: "working", prev: "idle" },
    { session_id: "s2", state: "waiting", prev: "idle" },
  ]);
});

describe("SessionFsm RUN_* emissions", () => {
  test("emits RUN_STARTED on first onJsonlLine after register", () => {
    const fsm = new SessionFsm();
    const events: AGUIEvent[] = [];
    fsm.onRunEvent((_, ev) => events.push(ev));
    fsm.register("s1");
    fsm.onJsonlLine("s1");
    const started = events.find((e) => e.type === EventType.RUN_STARTED);
    expect(started).toBeDefined();
    expect((started as { threadId: string }).threadId).toBe("s1");
  });

  test("emits RUN_FINISHED on idle timer fire", () => {
    const fsm = new SessionFsm();
    const events: AGUIEvent[] = [];
    fsm.onRunEvent((_, ev) => events.push(ev));
    fsm.register("s1");
    fsm.onJsonlLine("s1");          // idle → working, emits RUN_STARTED
    fsm.onIdleTimer("s1");          // working → idle, emits RUN_FINISHED
    expect(events.find((e) => e.type === EventType.RUN_FINISHED)).toBeDefined();
  });

  test("emits RUN_ERROR via onError API", () => {
    const fsm = new SessionFsm();
    const events: AGUIEvent[] = [];
    fsm.onRunEvent((_, ev) => events.push(ev));
    fsm.register("s1");
    fsm.onError("s1", { message: "spawn failed" });
    expect(events.find((e) => e.type === EventType.RUN_ERROR)).toBeDefined();
  });

  test("does NOT emit RUN_STARTED on permission-only activity (waiting state)", () => {
    const fsm = new SessionFsm();
    const events: AGUIEvent[] = [];
    fsm.onRunEvent((_, ev) => events.push(ev));
    fsm.register("s1");
    fsm.onPermissionRequest("s1");
    expect(events.filter((e) => e.type === EventType.RUN_STARTED).length).toBe(0);
  });
});
