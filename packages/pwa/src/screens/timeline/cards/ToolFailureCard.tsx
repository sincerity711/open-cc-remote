import { Terminal } from "lucide-react";
import { CatalogCard } from "./CatalogCard";
import { CatalogHeader } from "./CatalogHeader";

export function ToolFailureCard() {
  return (
    <CatalogCard tone="danger">
      <CatalogHeader
        icon={Terminal}
        title="Bash"
        meta="10:25 AM"
        tone="danger"
        status={<span className="text-danger text-xs font-semibold">Failed</span>}
      />
      <code className="mt-3 block font-mono text-xs">rm -rf node_modules</code>
      <p className="text-muted-foreground mt-2 text-xs">
        Exit code <span className="text-danger font-semibold">1</span>
      </p>
      <pre className="bg-danger-subtle text-danger mt-3 rounded-md font-mono text-xs leading-5">
Permission denied: node_modules
Operation not permitted
      </pre>
    </CatalogCard>
  );
}
