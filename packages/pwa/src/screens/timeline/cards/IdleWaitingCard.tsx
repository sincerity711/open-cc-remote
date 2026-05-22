import { PlayCircle } from "lucide-react";
import { CatalogCard } from "./CatalogCard";
import { CatalogHeader } from "./CatalogHeader";

export function IdleWaitingCard() {
  return (
    <CatalogCard>
      <CatalogHeader title="Waiting for input" meta="10:31 AM" />
      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm leading-5">
          How would you like to proceed?
        </p>
        <span className="border-border bg-muted inline-flex size-9 shrink-0 items-center justify-center rounded-full border">
          <PlayCircle className="text-muted-foreground size-5" />
        </span>
      </div>
    </CatalogCard>
  );
}
