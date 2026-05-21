import { CheckCircle2, ChevronRight, Users } from "lucide-react";
import { CatalogCard } from "./CatalogCard";
import { CatalogHeader } from "./CatalogHeader";

const expandedRows = [
  "Install deps",
  "Run unit tests",
  "Run integration tests",
  "Collect coverage",
];

export function SubagentCard({ expanded = false }: { expanded?: boolean }) {
  if (expanded) {
    return (
      <CatalogCard>
        <CatalogHeader
          icon={Users}
          title="Subagent: test-runner"
          tone="primary"
          status={<span className="text-success text-xs font-semibold">Completed</span>}
        />
        <div className="mt-3 grid gap-1">
          {expandedRows.map((row, index) => (
            <div className="flex items-center justify-between gap-2 text-xs" key={row}>
              <span className="flex items-center gap-2">
                <CheckCircle2 className="text-success size-3.5" />
                {row}
              </span>
              <span className="text-muted-foreground">{12 + index * 8}.4s</span>
            </div>
          ))}
        </div>
      </CatalogCard>
    );
  }

  return (
    <CatalogCard>
      <CatalogHeader icon={Users} title="Subagent: test-runner" tone="primary" />
      <p className="text-muted-foreground mt-2 text-xs">4 steps - 1m 12s</p>
      <div className="mt-4 flex items-center justify-between gap-2">
        <span className="text-muted-foreground text-xs">Click to expand</span>
        <ChevronRight className="text-muted-foreground size-4" />
      </div>
    </CatalogCard>
  );
}
