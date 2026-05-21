import { cn } from "../../lib/utils";

export function Field({
  label,
  mono,
  value,
}: {
  label: string;
  mono?: boolean;
  value: string;
}) {
  return (
    <div>
      <p className="text-muted-foreground text-xs font-semibold tracking-[0.12em] uppercase">
        {label}
      </p>
      <p className={cn("mt-1 text-sm", mono && "font-mono")}>{value}</p>
    </div>
  );
}
