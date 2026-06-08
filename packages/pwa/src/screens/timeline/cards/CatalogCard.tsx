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
  // Tall cards (permission, tool-use, ask) want a minimum height so the
  // timeline doesn't jitter when content is short. The reasoning card's
  // collapsed state is a single header row, where the floor leaves a big
  // empty band — opt out via `compact`.
  compact = false,
}: {
  children: React.ReactNode;
  tone?: CatalogCardTone;
  compact?: boolean;
}) {
  return (
    <article
      className={cn(
        "rounded-card shadow-card border p-3 text-sm cc-transition-state",
        !compact && "min-h-[92px]",
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
