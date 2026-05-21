import { ChevronRight, FileSearch } from "lucide-react";
import { CatalogCard } from "./CatalogCard";
import { CatalogHeader } from "./CatalogHeader";

export function ReadSearchCard() {
  return (
    <CatalogCard>
      <CatalogHeader icon={FileSearch} title="Read" meta="10:27 AM" tone="primary" />
      <div className="mt-3 flex items-center justify-between gap-2">
        <p className="truncate font-mono text-xs">src/lib/token.ts</p>
        <ChevronRight className="text-muted-foreground size-4 shrink-0" />
      </div>
      <p className="text-muted-foreground mt-2 text-xs">(128 lines)</p>
    </CatalogCard>
  );
}
