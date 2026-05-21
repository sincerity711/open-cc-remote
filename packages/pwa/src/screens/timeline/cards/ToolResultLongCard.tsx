import { ChevronRight, FileText } from "lucide-react";
import { CatalogCard } from "./CatalogCard";
import { CatalogHeader } from "./CatalogHeader";

export function ToolResultLongCard() {
  return (
    <CatalogCard>
      <CatalogHeader
        icon={FileText}
        title="Build"
        meta="10:26 AM"
        tone="primary"
        status={<span className="text-success text-xs font-semibold">Success</span>}
      />
      <p className="mt-3">Build completed with warnings</p>
      <button className="bg-muted mt-3 flex h-9 w-full items-center justify-between rounded-md px-3 text-xs font-semibold">
        View output (24 lines)
        <ChevronRight className="size-4" />
      </button>
    </CatalogCard>
  );
}
