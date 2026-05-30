import { cn } from "../../lib/utils";

export type SessionState = "waiting" | "working" | "idle" | "offline";

export type StatusChipTone =
  | "error"
  | "idle"
  | "offline"
  | "online"
  | "waiting"
  | "working";

/**
 * Inline status pill used everywhere a session/daemon state is shown.
 *
 * Motion contract:
 *   - `working`: the dot breathes (cc-pulse-working) so the user can feel
 *     that the session is alive without a spinner shouting for attention.
 *   - `waiting`: the chip nudges horizontally once every ~8s. Long enough
 *     between cycles to not be obnoxious; short enough that a glance at
 *     Home will catch it. This is the "money moment" state (design.md §14).
 *   - `online` / `idle` / `offline` / `error`: static.
 *
 * Reduced motion is honored via the global media query in styles.css.
 */
export function StatusChip({
  label,
  tone,
}: {
  label: string;
  tone: StatusChipTone;
}) {
  const animatesContainer = tone === "waiting";
  const animatesDot = tone === "working";

  return (
    <span
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-full border px-2 text-xs font-semibold cc-transition-state",
        tone === "online" && "border-success/30 bg-success-subtle text-success",
        tone === "waiting" &&
          "border-warning/45 bg-warning-subtle text-warning",
        tone === "working" &&
          "border-primary/30 bg-primary-subtle text-primary",
        tone === "idle" && "border-border bg-muted text-muted-foreground",
        tone === "offline" && "border-border bg-muted text-offline",
        tone === "error" && "border-danger/30 bg-danger-subtle text-danger",
        animatesContainer && "cc-nudge-waiting",
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full bg-current",
          animatesDot && "cc-pulse-working",
        )}
      />
      {label}
    </span>
  );
}
