import { cn } from "../../lib/utils";

export function ClaudeCodeMark({
  className,
  size = "md",
}: {
  className?: string;
  size?: "sm" | "md" | "lg" | "xl";
}) {
  return (
    <span
      className={cn(
        "shadow-card inline-flex shrink-0 items-center justify-center rounded-xl border border-slate-950/10 bg-gradient-to-br from-slate-900 to-slate-950 font-mono font-bold text-white",
        size === "sm" && "size-7 text-sm",
        size === "md" && "size-9 text-lg",
        size === "lg" && "size-12 text-2xl",
        size === "xl" && "size-20 text-[38px]",
        className,
      )}
      aria-label="Claude Code"
    >
      <span className="-mt-1 tracking-[-0.12em]">&gt;_</span>
    </span>
  );
}
