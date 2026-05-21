import { Plus } from "lucide-react";
import { CatalogCard } from "./CatalogCard";

const taskChips = ["api-reset", "email-token", "rate-limit"];

export function TaskCreatedCard() {
  return (
    <CatalogCard>
      <div className="flex flex-wrap gap-2">
        {taskChips.map((task) => (
          <span
            className="border-primary/25 bg-primary-subtle text-primary rounded-md border px-2 py-1 text-xs font-semibold"
            key={task}
          >
            {task}
          </span>
        ))}
      </div>
      <button className="text-muted-foreground mt-4 flex items-center gap-1 text-xs">
        <Plus className="size-3.5" />
        Add task
      </button>
    </CatalogCard>
  );
}
