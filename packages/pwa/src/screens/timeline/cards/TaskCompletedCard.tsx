import { CheckCircle2, ExternalLink } from "lucide-react";
import { CatalogCard } from "./CatalogCard";
import { CatalogHeader } from "./CatalogHeader";

export function TaskCompletedCard() {
  return (
    <CatalogCard tone="purple">
      <CatalogHeader icon={CheckCircle2} title="Task completed" meta="10:31 AM" tone="primary" />
      <p className="mt-2 font-semibold">feat: add password reset flow</p>
      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-muted-foreground text-xs">Commit a1b2c3d</span>
        <ExternalLink className="text-primary size-3.5" />
      </div>
    </CatalogCard>
  );
}
