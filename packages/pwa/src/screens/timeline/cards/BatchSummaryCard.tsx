import { ChevronRight, PackageCheck } from "lucide-react";
import { CatalogCard } from "./CatalogCard";
import { CatalogHeader } from "./CatalogHeader";

export function BatchSummaryCard() {
  return (
    <CatalogCard>
      <CatalogHeader icon={PackageCheck} title="Batch complete" meta="10:28 AM" tone="primary" />
      <p className="text-muted-foreground mt-2 text-xs">4 tools - 1m 12s</p>
      <p className="text-muted-foreground mt-1 text-xs">3 succeeded, 1 failed</p>
      <div className="border-border mt-3 flex items-center justify-between border-t pt-2">
        <span className="text-primary text-xs font-semibold">View details</span>
        <ChevronRight className="text-muted-foreground size-4" />
      </div>
    </CatalogCard>
  );
}
