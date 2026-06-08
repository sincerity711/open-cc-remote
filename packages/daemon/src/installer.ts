import { homedir, platform } from "node:os";
import { join } from "node:path";

export type InstallerPlatform = "darwin" | "linux" | "unsupported";

export interface UnitOptions {
  bun_path: string;
  cc_remote_bin: string;
  state_dir: string;
  /**
   * PATH to bake into the systemd/launchd unit. systemd user services and
   * launchd agents do NOT source the user's shell rc files, so without this
   * the daemon can't find `claude`, `git`, `tmux`, etc. when those live under
   * ~/.local/bin or ~/.bun/bin. Captured at install time via a login shell.
   * Optional — when absent the unit gets no Environment line and inherits the
   * platform default (matches pre-PATH-injection behaviour).
   */
  path_env?: string;
}

export interface PlatformCommands {
  reload: string[];
  enable: string[];
  start: string[];
}

export interface UninstallCommands {
  stop: string[];
  disable: string[];
  remove_file: boolean;
}

export function detectPlatform(): InstallerPlatform {
  const p = platform();
  if (p === "darwin") return "darwin";
  if (p === "linux") return "linux";
  return "unsupported";
}

export function unitPath(p: InstallerPlatform): string {
  if (p === "darwin") return join(homedir(), "Library", "LaunchAgents", "com.cc-remote.daemon.plist");
  if (p === "linux") return join(homedir(), ".config", "systemd", "user", "cc-remote-daemon.service");
  throw new Error(`unsupported platform: ${p}`);
}

export function unitContent(p: InstallerPlatform, opts: UnitOptions): string {
  const log = join(opts.state_dir, "daemon.log");
  if (p === "darwin") {
    // launchd plist string values must be XML-escaped.
    const pathXml = opts.path_env
      ? `\n    <key>PATH</key>\n    <string>${escapeXml(opts.path_env)}</string>`
      : "";
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyManager-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.cc-remote.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${opts.bun_path}</string>
    <string>${opts.cc_remote_bin}</string>
    <string>daemon</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${homedir()}</string>${pathXml}
  </dict>
</dict>
</plist>
`;
  }
  if (p === "linux") {
    // Environment= must come before ExecStart per systemd convention. systemd
    // values cannot contain newlines or unescaped quotes; PATH from a login
    // shell is well-formed for this.
    const envLine = opts.path_env ? `Environment=PATH=${opts.path_env}\n` : "";
    return `[Unit]
Description=cc-remote daemon
After=network.target

[Service]
Type=simple
${envLine}ExecStart=${opts.bun_path} ${opts.cc_remote_bin} daemon
Restart=always
RestartSec=2
StandardOutput=append:${log}
StandardError=append:${log}

[Install]
WantedBy=default.target
`;
  }
  throw new Error(`unsupported platform: ${p}`);
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function installCommands(p: InstallerPlatform, path: string): PlatformCommands {
  if (p === "darwin") {
    return {
      reload: [],
      enable: ["launchctl", "load", "-w", path],
      start: ["launchctl", "start", "com.cc-remote.daemon"],
    };
  }
  if (p === "linux") {
    return {
      reload: ["systemctl", "--user", "daemon-reload"],
      enable: ["systemctl", "--user", "enable", "cc-remote-daemon"],
      start: ["systemctl", "--user", "start", "cc-remote-daemon"],
    };
  }
  throw new Error(`unsupported platform: ${p}`);
}

export function uninstallCommands(p: InstallerPlatform, path: string): UninstallCommands {
  if (p === "darwin") {
    return { stop: ["launchctl", "unload", "-w", path], disable: [], remove_file: true };
  }
  if (p === "linux") {
    return {
      stop: ["systemctl", "--user", "stop", "cc-remote-daemon"],
      disable: ["systemctl", "--user", "disable", "cc-remote-daemon"],
      remove_file: true,
    };
  }
  throw new Error(`unsupported platform: ${p}`);
}
