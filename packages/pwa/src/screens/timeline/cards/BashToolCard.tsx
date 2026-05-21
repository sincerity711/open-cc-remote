import { Terminal } from "lucide-react";
import { CatalogCard } from "./CatalogCard";
import { CatalogHeader } from "./CatalogHeader";

export function BashToolCard() {
  return (
    <CatalogCard>
      <CatalogHeader
        icon={Terminal}
        title="Bash"
        meta="10:25 AM"
        status={<span className="text-success text-xs font-semibold">Success</span>}
      />
      <code className="mt-3 block font-mono text-xs">pnpm test auth</code>
      <p className="text-muted-foreground mt-2 truncate font-mono text-xs">
        cwd ~/awesome-project
      </p>
      <div className="border-border mt-3 border-t pt-2">
        <span className="text-warning text-xs font-semibold">2 warnings</span>
      </div>
    </CatalogCard>
  );
}
