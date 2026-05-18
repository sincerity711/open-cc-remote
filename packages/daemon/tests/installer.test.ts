import { test, expect } from "bun:test";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  detectPlatform,
  unitPath,
  unitContent,
  installCommands,
  uninstallCommands,
  type InstallerPlatform,
} from "../src/installer.ts";

const opts = {
  bun_path: "/usr/local/bin/bun",
  cc_remote_bin: "/x/cc-remote.ts",
  state_dir: "/Users/u/.cc-remote",
};

test("detectPlatform returns one of darwin/linux/unsupported", () => {
  const p = detectPlatform();
  expect(["darwin", "linux", "unsupported"]).toContain(p);
});

test("unitPath returns ~/.config/.../cc-remote-daemon.service for linux", () => {
  expect(unitPath("linux")).toBe(join(homedir(), ".config", "systemd", "user", "cc-remote-daemon.service"));
});

test("unitPath returns ~/Library/.../com.cc-remote.daemon.plist for darwin", () => {
  expect(unitPath("darwin")).toBe(join(homedir(), "Library", "LaunchAgents", "com.cc-remote.daemon.plist"));
});

test("unitContent for darwin produces valid XML plist with ProgramArguments", () => {
  const content = unitContent("darwin", opts);
  expect(content).toContain("<?xml version=\"1.0\"");
  expect(content).toContain("<key>Label</key>");
  expect(content).toContain("<string>com.cc-remote.daemon</string>");
  expect(content).toContain("<key>ProgramArguments</key>");
  expect(content).toContain("<string>/usr/local/bin/bun</string>");
  expect(content).toContain("<string>/x/cc-remote.ts</string>");
  expect(content).toContain("<string>daemon</string>");
  expect(content).toContain("<key>RunAtLoad</key>");
  expect(content).toContain("<key>KeepAlive</key>");
  expect(content).toContain("/Users/u/.cc-remote/daemon.log");
});

test("unitContent for linux produces valid systemd unit with ExecStart", () => {
  const content = unitContent("linux", opts);
  expect(content).toContain("[Unit]");
  expect(content).toContain("[Service]");
  expect(content).toContain("[Install]");
  expect(content).toContain("ExecStart=/usr/local/bin/bun /x/cc-remote.ts daemon");
  expect(content).toContain("Restart=always");
  expect(content).toContain("StandardOutput=append:/Users/u/.cc-remote/daemon.log");
  expect(content).toContain("WantedBy=default.target");
});

test("installCommands(darwin) returns load + start argv tuples", () => {
  const path = unitPath("darwin");
  const cmds = installCommands("darwin", path);
  expect(cmds.reload).toEqual([]); // no reload step on macOS, plist is loaded directly
  expect(cmds.enable).toEqual(["launchctl", "load", "-w", path]);
  expect(cmds.start).toEqual(["launchctl", "start", "com.cc-remote.daemon"]);
});

test("installCommands(linux) returns daemon-reload + enable + start tuples", () => {
  const path = unitPath("linux");
  const cmds = installCommands("linux", path);
  expect(cmds.reload).toEqual(["systemctl", "--user", "daemon-reload"]);
  expect(cmds.enable).toEqual(["systemctl", "--user", "enable", "cc-remote-daemon"]);
  expect(cmds.start).toEqual(["systemctl", "--user", "start", "cc-remote-daemon"]);
});

test("uninstallCommands(darwin) returns unload tuples", () => {
  const path = unitPath("darwin");
  const cmds = uninstallCommands("darwin", path);
  expect(cmds.stop).toEqual(["launchctl", "unload", "-w", path]);
  expect(cmds.disable).toEqual([]);
  expect(cmds.remove_file).toBe(true);
});

test("uninstallCommands(linux) returns stop+disable tuples", () => {
  const path = unitPath("linux");
  const cmds = uninstallCommands("linux", path);
  expect(cmds.stop).toEqual(["systemctl", "--user", "stop", "cc-remote-daemon"]);
  expect(cmds.disable).toEqual(["systemctl", "--user", "disable", "cc-remote-daemon"]);
  expect(cmds.remove_file).toBe(true);
});
