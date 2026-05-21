import type React from "react";
import { cn } from "../../../lib/utils";

export type CatalogCardTone =
  | "default"
  | "danger"
  | "success"
  | "warning"
  | "purple";

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
        "rounded-card shadow-card min-h-[92px] border p-3 text-sm",
        tone === "default" && "border-border bg-surface",
        tone === "danger" && "border-danger/30 bg-danger-subtle",
        tone === "success" && "border-success/30 bg-success-subtle",
        tone === "warning" && "border-warning/35 bg-warning-subtle",
        tone === "purple" && "border-primary/25 bg-primary-subtle",
      )}
    >
      {children}
    </article>
  );
}
