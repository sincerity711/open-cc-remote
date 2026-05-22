import { ChevronRight } from "lucide-react";
import { CatalogCard } from "./CatalogCard";

export function ReasoningCard() {
  return (
    <CatalogCard>
      <div className="flex items-center justify-between gap-2">
        <p className="font-semibold">Reasoning (5 steps)</p>
        <ChevronRight className="text-muted-foreground size-4" />
      </div>
      <p className="text-muted-foreground mt-4 text-center text-xs">
        Click to expand
      </p>
    </CatalogCard>
  );
}
