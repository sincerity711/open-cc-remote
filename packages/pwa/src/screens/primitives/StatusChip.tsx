import { cn } from "../../lib/utils";

export type SessionState = "waiting" | "working" | "idle" | "offline";

export type StatusChipTone =
  | "error"
  | "idle"
  | "offline"
  | "online"
  | "waiting"
  | "working";

export function StatusChip({
  label,
  tone,
}: {
  label: string;
  tone: StatusChipTone;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-full border px-2 text-xs font-semibold",
        tone === "online" && "border-success/30 bg-success-subtle text-success",
        tone === "waiting" &&
          "border-warning/30 bg-warning-subtle text-warning",
        tone === "working" &&
          "border-primary/30 bg-primary-subtle text-primary",
        tone === "idle" && "border-border bg-muted text-muted-foreground",
        tone === "offline" && "border-border bg-muted text-offline",
        tone === "error" && "border-danger/30 bg-danger-subtle text-danger",
      )}
    >
      <span className="size-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}
