# open-cc-remote — Plan 8: launchd / systemd installer

> **For agentic workers:** Compressed. Full code in dispatch prompts.

**Goal:** `cc-remote install` writes a platform-appropriate service file (launchd plist on macOS, systemd user unit on Linux), loads it, starts the daemon. `cc-remote uninstall` reverses.

**Architecture:**
- Detect platform: `process.platform === "darwin"` → launchd; `=== "linux"` → systemd; else → unsupported with clear message
- File templates inlined in code (small)
- macOS: `~/Library/LaunchAgents/com.cc-remote.daemon.plist`, then `launchctl load -w <path>` and `launchctl start com.cc-remote.daemon`
- Linux: `~/.config/systemd/user/cc-remote-daemon.service`, then `systemctl --user daemon-reload && systemctl --user enable --now cc-remote-daemon`
- Both use `bun /path/to/cc-remote daemon` as the ExecStart
- Unit log at `~/.cc-remote/daemon.log` (also for stderr capture)

**Testable surface:**
- File path resolution per platform — pure function, easy unit test
- File content generation — pure function, snapshot-style assertions
- Actual `launchctl` / `systemctl` calls are NOT tested in unit tests (would interfere with the user's real system); we expose a `--dry-run` flag for verification

**Out of scope:** Windows (separate plan if needed), automatic upgrades, log rotation.

---

## Tasks

### T1 — Installer logic library

`packages/daemon/src/installer.ts`:
- `detectPlatform(): "darwin" | "linux" | "unsupported"`
- `unitPath(platform): string` — full path including filename
- `unitContent(platform, opts): string` — opts include `bun_path`, `cc_remote_bin`, `state_dir`
- `installCommands(platform, unitPath): { reload: string[]; enable: string[]; start: string[] }` — arrays of argv tuples for the privileged commands
- `uninstallCommands(platform, unitPath): { stop: string[]; disable: string[]; remove_file: boolean }`

Tests for each function across both platforms. No actual subprocess calls — just string assertions.

### T2 — `cc-remote install` / `cc-remote uninstall` subcommands

`packages/daemon/bin/cc-remote.ts`:
- `cmdInstall(args)`: detect platform, generate file, write it, run reload/enable/start (unless `--dry-run`)
- `cmdUninstall()`: stop, disable, remove file
- `--dry-run` flag prints what would be done without doing it

Tests via a small subprocess invocation in dry-run mode (golden output check).

### T3 — README + tag

Document the install flow, tag `plan-08-install`.
