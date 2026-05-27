import { test, expect } from "bun:test";
import { RateLimiter } from "../src/rate-limit.ts";

test("RateLimiter allows up to limit, rejects the next", () => {
  const rl = new RateLimiter(60_000);
  const t = 1_000_000;
  for (let i = 0; i < 10; i++) expect(rl.check("ip", 10, t + i)).toBe(true);
  expect(rl.check("ip", 10, t + 100)).toBe(false);
});

test("RateLimiter window slides", () => {
  const rl = new RateLimiter(60_000);
  const t = 1_000_000;
  for (let i = 0; i < 10; i++) expect(rl.check("ip", 10, t + i)).toBe(true);
  expect(rl.check("ip", 10, t + 100)).toBe(false);
  // 61 sec later, the original 10 entries fall out of the window.
  expect(rl.check("ip", 10, t + 61_000)).toBe(true);
});

test("RateLimiter is keyed per IP", () => {
  const rl = new RateLimiter(60_000);
  const t = 1_000_000;
  for (let i = 0; i < 10; i++) expect(rl.check("a", 10, t + i)).toBe(true);
  expect(rl.check("a", 10, t + 100)).toBe(false);
  expect(rl.check("b", 10, t + 100)).toBe(true);
});

test("RateLimiter limit <= 0 disables checking", () => {
  const rl = new RateLimiter(60_000);
  for (let i = 0; i < 1000; i++) expect(rl.check("ip", 0, 1_000_000)).toBe(true);
});
