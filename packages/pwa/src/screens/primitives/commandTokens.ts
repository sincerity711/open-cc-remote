/**
 * Lightweight tokenizer for shell commands shown in InlinePermissionCard.
 *
 * The goal is decision-support, not security analysis. We do best-effort
 * token classification to give the eye a hand:
 *   - destructive verbs (rm, sudo, chmod, …) → "danger" → rendered red
 *   - flags (anything starting with `-`)     → "flag"   → rendered muted
 *   - paths and absolute roots                → "path"   → rendered default
 *   - everything else                         → "plain"
 *
 * We also look for risky patterns ("rm -rf", "curl | sh", "git reset --hard")
 * across the whole command, not just per-token, and surface them so the
 * card can show a small "high risk" badge.
 *
 * Heuristics intentionally err on the side of warning. The user has the
 * final decision; our job is to make destructive intent legible at a glance.
 */
export type TokenKind = "danger" | "flag" | "path" | "plain";

export interface CommandToken {
  text: string;
  kind: TokenKind;
}

const DESTRUCTIVE_VERBS = new Set([
  "rm",
  "rmdir",
  "sudo",
  "doas",
  "chmod",
  "chown",
  "dd",
  "kill",
  "killall",
  "shutdown",
  "reboot",
  "format",
  "mkfs",
]);

interface RiskMatcher {
  label: string;
  match(command: string, tokens: CommandToken[]): boolean;
}

const RISK_MATCHERS: readonly RiskMatcher[] = [
  {
    label: "recursive delete",
    match: (cmd) => /\brm\b[^|;]*-[a-zA-Z]*r[a-zA-Z]*f|\brm\b[^|;]*-[a-zA-Z]*f[a-zA-Z]*r/i.test(cmd),
  },
  {
    label: "elevated privileges",
    match: (cmd) => /\b(sudo|doas)\b/.test(cmd),
  },
  {
    label: "pipe to shell",
    match: (cmd) => /(curl|wget|fetch)[^|]*\|\s*(sh|bash|zsh|fish|sudo)/.test(cmd),
  },
  {
    label: "destructive git",
    match: (cmd) => /\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-[a-zA-Z]*[fdx]+/.test(cmd),
  },
  {
    label: "recursive chmod/chown",
    match: (cmd) => /\b(chmod|chown)\b[^|;]*-[a-zA-Z]*R/.test(cmd),
  },
  {
    label: "system prune",
    match: (cmd) => /\bdocker\s+system\s+prune\b/.test(cmd),
  },
];

export function tokenizeCommand(command: string): CommandToken[] {
  // Split while keeping whitespace runs intact so the tokens reassemble
  // verbatim. The simple split on /(\s+)/ gives us alternating
  // whitespace/non-whitespace segments.
  const parts = command.split(/(\s+)/);
  return parts.map((part) => classify(part));
}

function classify(part: string): CommandToken {
  if (!part) return { text: part, kind: "plain" };
  if (/^\s+$/.test(part)) return { text: part, kind: "plain" };
  if (part.startsWith("-")) return { text: part, kind: "flag" };
  if (DESTRUCTIVE_VERBS.has(part.toLowerCase())) {
    return { text: part, kind: "danger" };
  }
  if (
    part.startsWith("/") ||
    part.startsWith("~") ||
    part.startsWith("./") ||
    part.startsWith("../")
  ) {
    return { text: part, kind: "path" };
  }
  return { text: part, kind: "plain" };
}

export function detectRisks(command: string): readonly string[] {
  const tokens = tokenizeCommand(command);
  return RISK_MATCHERS.filter((m) => m.match(command, tokens)).map((m) => m.label);
}
