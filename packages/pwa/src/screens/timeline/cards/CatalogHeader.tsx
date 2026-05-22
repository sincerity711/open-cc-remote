import type { LucideIcon } from "lucide-react";
import type React from "react";
import { cn } from "../../../lib/utils";

export type CatalogHeaderTone =
  | "danger"
  | "default"
  | "primary"
  | "success"
  | "warning";

export function CatalogHeader({
  icon: Icon,
  meta,
  status,
  title,
  tone = "default",
}: {
  icon?: LucideIcon;
  meta?: string;
  status?: React.ReactNode;
  title: string;
  tone?: CatalogHeaderTone;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <p className="flex min-w-0 items-center gap-2 font-semibold">
        {Icon && (
          <span
            className={cn(
              "border-border bg-muted inline-flex size-6 shrink-0 items-center justify-center rounded-md border",
              tone === "primary" && "border-primary/25 bg-primary-subtle",
              tone === "success" && "border-success/25 bg-success-subtle",
              tone === "warning" && "border-warning/30 bg-warning-subtle",
              tone === "danger" && "border-danger/30 bg-danger-subtle",
            )}
          >
            <Icon
              className={cn(
                "size-3.5",
                tone === "primary" && "text-primary",
                tone === "success" && "text-success",
                tone === "warning" && "text-warning",
                tone === "danger" && "text-danger",
              )}
            />
          </span>
        )}
        <span className="truncate">{title}</span>
      </p>
      {status ?? (
        <span className="text-muted-foreground shrink-0 text-xs">{meta}</span>
      )}
    </div>
  );
}
