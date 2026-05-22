import { CatalogCard } from "./CatalogCard";
import { CatalogHeader } from "./CatalogHeader";

export function SystemNoticeCard() {
  return (
    <CatalogCard>
      <CatalogHeader title="System" meta="10:22 AM" />
      <div className="text-muted-foreground mt-3 grid gap-1 text-xs">
        <p>Session started</p>
        <p>Claude Sonnet 3.5</p>
        <p>Context window 128k</p>
      </div>
    </CatalogCard>
  );
}
