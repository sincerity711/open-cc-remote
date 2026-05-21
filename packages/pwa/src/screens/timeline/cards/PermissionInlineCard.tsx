import { ShieldAlert } from "lucide-react";
import { Button } from "../../../components/ui/button";
import { CatalogCard } from "./CatalogCard";
import { CatalogHeader } from "./CatalogHeader";

export function PermissionInlineCard() {
  return (
    <CatalogCard tone="warning">
      <CatalogHeader icon={ShieldAlert} title="Permission required" meta="10:26 AM" tone="warning" />
      <div className="mt-3 grid gap-1 text-xs">
        <p>Tool <span className="ml-6 font-mono">Bash</span></p>
        <p>Command <span className="font-mono">rm -rf node_modules</span></p>
      </div>
      <Button className="mt-3 w-full" size="sm" variant="secondary">
        Review
      </Button>
    </CatalogCard>
  );
}
