import { CheckCircle2 } from "lucide-react";
import { CatalogCard } from "./CatalogCard";
import { CatalogHeader } from "./CatalogHeader";

export function ToolResultShortCard() {
  return (
    <CatalogCard>
      <CatalogHeader
        icon={CheckCircle2}
        title="Tests"
        tone="success"
        status={<span className="text-success text-xs font-semibold">Success</span>}
      />
      <p className="mt-3">All 42 tests passed</p>
      <p className="text-muted-foreground mt-2 text-xs">Duration 1.8s</p>
    </CatalogCard>
  );
}
