import { Pencil } from "lucide-react";
import { CatalogCard } from "./CatalogCard";
import { CatalogHeader } from "./CatalogHeader";

export function FileEditCard() {
  return (
    <CatalogCard>
      <CatalogHeader
        icon={Pencil}
        title="Edit"
        meta="10:27 AM"
        tone="success"
        status={
          <span className="shrink-0 text-xs font-semibold">
            <span className="text-success">+24</span>{" "}
            <span className="text-danger">-6</span>
          </span>
        }
      />
      <p className="mt-3 truncate font-mono text-xs">src/routes/auth/reset.ts</p>
      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-muted-foreground text-xs">Lines 45-68</span>
        <span className="text-primary text-xs font-semibold">View diff</span>
      </div>
    </CatalogCard>
  );
}
