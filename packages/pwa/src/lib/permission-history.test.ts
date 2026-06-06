import { describe, expect, test } from "bun:test";
import type {
  PwaAskUserQuestionRequest,
  PwaPermissionRequest,
} from "@cc-remote/proto";
import {
  PERMISSION_HISTORY_LRU_MAX,
  findAskQuestionAnswers,
  findAskQuestionRequest,
  findPermissionRequest,
  insertWithLru,
} from "./permission-history";

const baseReq = (id: string): PwaPermissionRequest => ({
  type: "permission_request",
  daemon_id: "d",
  session_id: "s",
  request_id: id,
  tool: "Bash",
  args_summary: `cmd-${id}`,
  expires_at: 0,
});

const baseAsk = (id: string): PwaAskUserQuestionRequest => ({
  type: "ask_user_question_request",
  daemon_id: "d",
  session_id: "s",
  request_id: id,
  questions: [
    { question: `q-${id}`, header: "", multiSelect: false, options: [{ label: "yes" }] },
  ],
  expires_at: 0,
});

describe("insertWithLru", () => {
  test("inserts a new entry", () => {
    const out = insertWithLru({}, "k1", baseReq("k1"));
    expect(out["k1"]?.request_id).toBe("k1");
  });

  test("returns a new object (immutability)", () => {
    const before = {} as Record<string, PwaPermissionRequest>;
    const after = insertWithLru(before, "k1", baseReq("k1"));
    expect(after).not.toBe(before);
    expect(Object.keys(before)).toHaveLength(0);
  });

  test("re-setting an existing key bumps it to newest", () => {
    let out = insertWithLru({}, "a", baseReq("a"));
    out = insertWithLru(out, "b", baseReq("b"));
    out = insertWithLru(out, "a", baseReq("a-updated"));
    const keys = Object.keys(out);
    // Order: oldest -> newest. After bump, "a" should be last.
    expect(keys).toEqual(["b", "a"]);
    expect(out["a"]?.args_summary).toBe("cmd-a-updated");
  });

  test("evicts oldest when size exceeds max (max=3)", () => {
    let out: Record<string, PwaPermissionRequest> = {};
    out = insertWithLru(out, "a", baseReq("a"), 3);
    out = insertWithLru(out, "b", baseReq("b"), 3);
    out = insertWithLru(out, "c", baseReq("c"), 3);
    out = insertWithLru(out, "d", baseReq("d"), 3);
    expect(Object.keys(out)).toEqual(["b", "c", "d"]);
    expect(out["a"]).toBeUndefined();
  });

  test("evicts at the documented default LRU bound (64)", () => {
    let out: Record<string, PwaPermissionRequest> = {};
    for (let i = 0; i < PERMISSION_HISTORY_LRU_MAX + 1; i++) {
      out = insertWithLru(out, `r${i}`, baseReq(`r${i}`));
    }
    expect(Object.keys(out)).toHaveLength(PERMISSION_HISTORY_LRU_MAX);
    expect(out["r0"]).toBeUndefined();
    expect(out[`r${PERMISSION_HISTORY_LRU_MAX}`]).toBeDefined();
  });
});

describe("findPermissionRequest", () => {
  test("returns the entry when present", () => {
    const h = { p1: baseReq("p1") };
    expect(findPermissionRequest(h, "p1")?.request_id).toBe("p1");
  });

  test("returns null when missing (cross-device path)", () => {
    expect(findPermissionRequest({}, "missing")).toBeNull();
  });
});

describe("findAskQuestionRequest", () => {
  test("returns the entry when present", () => {
    const h = { a1: baseAsk("a1") };
    expect(findAskQuestionRequest(h, "a1")?.request_id).toBe("a1");
  });

  test("returns null when missing", () => {
    expect(findAskQuestionRequest({}, "missing")).toBeNull();
  });
});

describe("findAskQuestionAnswers", () => {
  test("returns answers when present", () => {
    const h = { a1: ["yes"] };
    expect(findAskQuestionAnswers(h, "a1")).toEqual(["yes"]);
  });

  test("returns null when missing (cross-device — PWA never submitted)", () => {
    expect(findAskQuestionAnswers({}, "missing")).toBeNull();
  });
});
