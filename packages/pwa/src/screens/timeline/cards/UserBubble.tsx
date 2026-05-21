import { CatalogCard } from "./CatalogCard";

export function UserBubble() {
  return (
    <CatalogCard>
      <UserBubbleSurface />
    </CatalogCard>
  );
}

export function UserBubbleSurface() {
  return (
    <div className="bg-primary-subtle border-primary/20 ml-auto max-w-[92%] rounded-md border p-3">
      <p>Please add password reset flow using email tokens.</p>
      <p className="text-muted-foreground mt-2 text-right text-xs">10:24 AM</p>
    </div>
  );
}
