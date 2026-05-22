import { CatalogCard } from "./CatalogCard";
import { CatalogHeader } from "./CatalogHeader";

export function AssistantBubble() {
  return (
    <CatalogCard>
      <CatalogHeader title="Claude" meta="10:24 AM" />
      <p className="mt-2 leading-5">
        I'll plan the implementation and create the necessary endpoints.
      </p>
    </CatalogCard>
  );
}
