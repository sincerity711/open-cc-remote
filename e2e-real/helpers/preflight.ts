// Pre-flight checks for the e2e-real test suite. Fail fast with actionable
// guidance if a host prerequisite is missing.

import { spawnSync } from "node:child_process";

interface PreflightCheck {
  ok: boolean;
  message: string;
}

interface PreflightResult {
  ok: boolean;
  checks: PreflightCheck[];
  /** Soft-warning checks that didn't fail the suite. */
  warnings: string[];
}

const KNOWN_GOOD_MIN = "2.1.144";

function cmpSemver(a: string, b: string): number {
  const pa = a.split(".").map((s) => Number(s) || 0);
  const pb = b.split(".").map((s) => Number(s) || 0);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0, db = pb[i] ?? 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  return 0;
}

function check(label: string, ok: boolean, hint: string): PreflightCheck {
  return { ok, message: ok ? `${label}: OK` : `${label}: FAIL — ${hint}` };
}

export function preflight(): PreflightResult {
  const checks: PreflightCheck[] = [];
  const warnings: string[] = [];

  const dockerInfo = spawnSync("docker", ["info"], { encoding: "utf8" });
  checks.push(check("docker daemon", (dockerInfo.status ?? -1) === 0,
    "is the docker daemon running? `docker info` must succeed"));

  const which = (cmd: string) => spawnSync("which", [cmd], { encoding: "utf8" }).status === 0;

  checks.push(check("claude on PATH", which("claude"),
    "install Claude Code CLI 2.1.144+ and ensure `claude` resolves on PATH"));
  checks.push(check("tmux on PATH", which("tmux"),
    "install tmux (`brew install tmux` on macOS)"));

  const apiKey = process.env.ANTHROPIC_API_KEY;
  checks.push(check("ANTHROPIC_API_KEY set", !!apiKey,
    "export ANTHROPIC_API_KEY in your shell before running e2e-real"));

  // Soft check: claude version. Out-of-range only warns.
  if (which("claude")) {
    const ver = spawnSync("claude", ["--version"], { encoding: "utf8" });
    if (ver.status === 0) {
      const m = /(\d+\.\d+\.\d+)/.exec(ver.stdout || "");
      if (m) {
        if (cmpSemver(m[1]!, KNOWN_GOOD_MIN) < 0) {
          warnings.push(`claude version ${m[1]} < known-good ${KNOWN_GOOD_MIN}; tmux dialog regexes may need updating`);
        }
      } else {
        warnings.push(`could not parse claude version from: ${ver.stdout}`);
      }
    }
  }

  const ok = checks.every((c) => c.ok);
  return { ok, checks, warnings };
}

export function preflightOrThrow(): void {
  const r = preflight();
  for (const w of r.warnings) {
    process.stderr.write(`[preflight] WARNING: ${w}\n`);
  }
  if (!r.ok) {
    const lines = r.checks.map((c) => `  ${c.message}`).join("\n");
    throw new Error(`e2e-real preflight failed:\n${lines}`);
  }
}
