import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { createDevice } from "../src/repos/devices.ts";
import { isInDndWindow } from "../src/dnd.ts";
import { getDndSettings, setDndSettings } from "../src/repos/dnd.ts";

const at = (iso: string) => new Date(iso).getTime();

test("disabled DND never matches", () => {
  expect(isInDndWindow({ enabled: false, start_hh_mm: "22:00", end_hh_mm: "07:00", timezone: "UTC" }, at("2026-05-26T03:00:00Z"))).toBe(false);
});

test("missing fields treated as disabled", () => {
  expect(isInDndWindow({ enabled: true, start_hh_mm: null, end_hh_mm: "07:00", timezone: "UTC" }, Date.now())).toBe(false);
  expect(isInDndWindow(null, Date.now())).toBe(false);
});

test("single-day window: inside, before, after, exact boundaries", () => {
  const dnd = { enabled: true, start_hh_mm: "09:00", end_hh_mm: "17:00", timezone: "UTC" };
  expect(isInDndWindow(dnd, at("2026-05-26T08:59:00Z"))).toBe(false);
  expect(isInDndWindow(dnd, at("2026-05-26T09:00:00Z"))).toBe(true);
  expect(isInDndWindow(dnd, at("2026-05-26T16:59:00Z"))).toBe(true);
  expect(isInDndWindow(dnd, at("2026-05-26T17:00:00Z"))).toBe(false);
});

test("cross-midnight window includes evening and early morning", () => {
  const dnd = { enabled: true, start_hh_mm: "22:00", end_hh_mm: "07:00", timezone: "UTC" };
  expect(isInDndWindow(dnd, at("2026-05-26T22:30:00Z"))).toBe(true);
  expect(isInDndWindow(dnd, at("2026-05-26T03:00:00Z"))).toBe(true);
  expect(isInDndWindow(dnd, at("2026-05-26T07:00:00Z"))).toBe(false);
  expect(isInDndWindow(dnd, at("2026-05-26T12:00:00Z"))).toBe(false);
});

test("start == end is treated as never matching", () => {
  const dnd = { enabled: true, start_hh_mm: "08:00", end_hh_mm: "08:00", timezone: "UTC" };
  expect(isInDndWindow(dnd, at("2026-05-26T08:00:00Z"))).toBe(false);
  expect(isInDndWindow(dnd, at("2026-05-26T20:00:00Z"))).toBe(false);
});

test("invalid IANA timezone treated as disabled", () => {
  const dnd = { enabled: true, start_hh_mm: "00:00", end_hh_mm: "23:00", timezone: "Mars/Olympus" };
  expect(isInDndWindow(dnd, Date.now())).toBe(false);
});

test("timezone shifts window: 22:00–07:00 Asia/Shanghai", () => {
  const dnd = { enabled: true, start_hh_mm: "22:00", end_hh_mm: "07:00", timezone: "Asia/Shanghai" };
  expect(isInDndWindow(dnd, at("2026-05-25T22:00:00Z"))).toBe(true);  // 06:00 Shanghai → in window
  expect(isInDndWindow(dnd, at("2026-05-26T04:00:00Z"))).toBe(false); // 12:00 Shanghai → outside
});

function setupDb() {
  const dir = mkdtempSync(join(tmpdir(), "ccr-dnd-"));
  const db = openDb(join(dir, "h.sqlite"));
  db.prepare("INSERT INTO users (sub, created_at) VALUES (?, ?)").run("u1", 1);
  const c = createDevice(db, "u1", "iPhone", null, 60_000);
  return { db, device_id: c.device_id, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("getDndSettings returns null for never-set device", () => {
  const s = setupDb();
  try {
    expect(getDndSettings(s.db, s.device_id)).toBeNull();
  } finally { s.cleanup(); }
});

test("setDndSettings round-trips", () => {
  const s = setupDb();
  try {
    setDndSettings(s.db, s.device_id, { enabled: true, start_hh_mm: "22:00", end_hh_mm: "07:00", timezone: "UTC" });
    expect(getDndSettings(s.db, s.device_id)).toEqual({
      enabled: true, start_hh_mm: "22:00", end_hh_mm: "07:00", timezone: "UTC",
    });
  } finally { s.cleanup(); }
});
