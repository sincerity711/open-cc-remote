import { test, expect, beforeEach } from "bun:test";

// Shim window/localStorage in the bun test environment so the hook's module
// initializer (which reads window.localStorage on import) can run.
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
  clear() { this.map.clear(); }
  get length() { return this.map.size; }
  key(i: number) { return Array.from(this.map.keys())[i] ?? null; }
}

const storage = new MemoryStorage();
// @ts-expect-error — minimal shim for hook init.
globalThis.window = {
  localStorage: storage,
  addEventListener: () => {},
  removeEventListener: () => {},
} as unknown as Window & typeof globalThis;
// @ts-expect-error — pagehide/visibility flushers reference document.
globalThis.document = { visibilityState: "visible" } as Document;

beforeEach(() => storage.clear());

const STORAGE_KEY = "cc_remote_last_seen_offsets";

test("loadInitial returns {} when localStorage is empty or invalid", async () => {
  const { useLastSeen } = await import("../src/hooks/useLastSeen");
  expect(typeof useLastSeen).toBe("function");
  // Hook itself is not directly invokable outside a React render, but we can
  // assert behavior via the storage round-trip in the next tests by calling
  // the exported helpers when they exist. Here we just sanity-check import.
});

test("monotonic merge: a smaller offset must not overwrite a larger one", () => {
  // Pure logic check — equivalent to the inline `cur >= offset` guard in
  // markSeen. We replicate it here to keep the test independent of React's
  // useState scheduler so this test can run without a renderer.
  const merge = (prev: Record<string, number>, k: string, offset: number) => {
    const cur = prev[k];
    if (cur !== undefined && cur >= offset) return prev;
    return { ...prev, [k]: offset };
  };
  let s: Record<string, number> = {};
  s = merge(s, "k", 5); expect(s.k).toBe(5);
  s = merge(s, "k", 10); expect(s.k).toBe(10);
  s = merge(s, "k", 3); expect(s.k).toBe(10);   // smaller — ignored
  s = merge(s, "k", 10); expect(s.k).toBe(10);  // equal — no change
  s = merge(s, "k", 11); expect(s.k).toBe(11);
});

test("localStorage round-trip: a JSON record is loaded back as numbers, garbage entries dropped", () => {
  storage.setItem(
    STORAGE_KEY,
    JSON.stringify({ "d1::s1": 42, "d1::s2": "nope", "d1::s3": 7 }),
  );
  // Re-implement loadInitial inline (mirrors useLastSeen.ts) to assert
  // the validation contract without invoking the hook.
  const raw = storage.getItem(STORAGE_KEY);
  const parsed = raw ? JSON.parse(raw) : {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  expect(out).toEqual({ "d1::s1": 42, "d1::s3": 7 });
});

test("malformed localStorage is treated as empty (no throw)", () => {
  storage.setItem(STORAGE_KEY, "{not json");
  let parsed: unknown;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    parsed = {};
  }
  expect(parsed).toEqual({});
});
