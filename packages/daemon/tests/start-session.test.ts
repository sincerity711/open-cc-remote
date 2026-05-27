import { test, expect } from "bun:test";
import { precheckStartSession } from "../src/start-session.ts";

const HOME = "/Users/me";
const homedir = () => HOME;

test("precheckStartSession rejects when allow_start=false", () => {
  const r = precheckStartSession(
    { cwd: "/Users/me/work" },
    { allow_start: false, allowed_cwd_prefix: ["/Users/me"], spawn_command: "claude" },
    { homedir, mkdirSync: () => {} },
  );
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toBe("not_allowed");
});

test("precheckStartSession rejects cwd outside allowed_cwd_prefix", () => {
  const r = precheckStartSession(
    { cwd: "/etc" },
    { allow_start: true, allowed_cwd_prefix: ["/Users/me"], spawn_command: "claude" },
    { homedir, mkdirSync: () => {} },
  );
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.reason).toBe("cwd_not_allowed");
    expect(r.cwd).toBe("/etc");
  }
});

test("precheckStartSession expands ~ before prefix check", () => {
  const r = precheckStartSession(
    { cwd: "~/proj" },
    { allow_start: true, allowed_cwd_prefix: ["/Users/me"], spawn_command: "claude" },
    { homedir, mkdirSync: () => {} },
  );
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.cwd).toBe("/Users/me/proj");
});

test("precheckStartSession rejects when spawn_command missing", () => {
  const r = precheckStartSession(
    { cwd: "/Users/me/x" },
    { allow_start: true, allowed_cwd_prefix: ["/Users/me"], spawn_command: undefined },
    { homedir, mkdirSync: () => {} },
  );
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toBe("spawn_command_unset");
});

test("precheckStartSession rejects when mkdir throws (e.g. EACCES)", () => {
  const r = precheckStartSession(
    { cwd: "/Users/me/protected" },
    { allow_start: true, allowed_cwd_prefix: ["/Users/me"], spawn_command: "claude" },
    {
      homedir,
      mkdirSync: () => {
        throw new Error("EACCES: permission denied");
      },
    },
  );
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.reason).toBe("mkdir_failed");
    expect(r.message).toContain("EACCES");
  }
});

test("precheckStartSession ok path returns expanded cwd and invokes mkdir -p", () => {
  let mkdirCalled: string | null = null;
  const r = precheckStartSession(
    { cwd: "~/new-dir" },
    { allow_start: true, allowed_cwd_prefix: ["/Users/me"], spawn_command: "claude" },
    {
      homedir,
      mkdirSync: (p, opts) => {
        mkdirCalled = p;
        expect(opts.recursive).toBe(true);
      },
    },
  );
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.cwd).toBe("/Users/me/new-dir");
  expect(mkdirCalled as string | null).toBe("/Users/me/new-dir");
});

test("precheckStartSession rejects ~ that resolves outside prefix", () => {
  // homedir = /Users/me but allowed prefix only /tmp.
  const r = precheckStartSession(
    { cwd: "~/secret" },
    { allow_start: true, allowed_cwd_prefix: ["/tmp"], spawn_command: "claude" },
    { homedir, mkdirSync: () => {} },
  );
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toBe("cwd_not_allowed");
});
