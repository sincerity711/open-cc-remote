import { ShieldCheck } from "lucide-react";
import { CatalogCard } from "./CatalogCard";
import { CatalogHeader } from "./CatalogHeader";

export function PermissionResolvedCard() {
  return (
    <CatalogCard tone="success">
      <CatalogHeader icon={ShieldCheck} title="Permission granted" meta="10:27 AM" tone="success" />
      <code className="mt-3 block font-mono text-xs">rm -rf node_modules</code>
    </CatalogCard>
  );
}
