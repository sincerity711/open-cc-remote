import type React from "react";
import { cn } from "../../../lib/utils";

export type CatalogCardTone =
  | "default"
  | "danger"
  | "success"
  | "warning"
  | "active";

export function CatalogCard({
  children,
  tone = "default",
}: {
  children: React.ReactNode;
  tone?: CatalogCardTone;
}) {
  return (
    <article
      className={cn(
        "rounded-card shadow-card min-h-[92px] border p-3 text-sm cc-transition-state",
        tone === "default" && "border-border bg-surface",
        tone === "danger" && "border-danger/30 bg-danger-subtle",
        tone === "success" && "border-success/30 bg-success-subtle",
        tone === "warning" && "border-warning/35 bg-warning-subtle",
        // Active tool — primary tint on the left edge so the eye lands on
        // it as "the one currently running" without the whole card tinting.
        tone === "active" &&
          "border-border bg-surface border-l-2 border-l-primary/60",
      )}
    >
      {children}
    </article>
  );
}
