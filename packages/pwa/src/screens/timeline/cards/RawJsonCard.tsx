import { ChevronRight } from "lucide-react";
import { CatalogCard } from "./CatalogCard";
import { CatalogHeader } from "./CatalogHeader";

export function RawJsonCard() {
  return (
    <CatalogCard>
      <CatalogHeader title="Unknown message" meta="10:22 AM" />
      <pre className="bg-muted mt-3 overflow-hidden rounded-md p-2 font-mono text-xs leading-5">
{`{
  "type": "event_unknown",
  "payload": { "foo": "bar" }
}`}
      </pre>
      <div className="mt-3 flex items-center justify-between">
        <span className="text-primary text-xs font-semibold">View raw</span>
        <ChevronRight className="text-muted-foreground size-4" />
      </div>
    </CatalogCard>
  );
}
