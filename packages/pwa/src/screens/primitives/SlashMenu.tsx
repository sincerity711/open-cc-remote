import { useEffect, useMemo, useState } from "react";
import type { SlashEntry } from "@cc-remote/proto";

export interface SlashMenuProps {
  entries: SlashEntry[];
  /** Current composer text. Menu only renders when draft starts with "/". */
  draft: string;
  /** Called when the user activates an entry (Enter / click). */
  onSelect(entry: SlashEntry): void;
  /** Called when the user dismisses (Escape). */
  onDismiss?(): void;
}

export function filterEntries(entries: SlashEntry[], draft: string): SlashEntry[] {
  if (!draft.startsWith("/")) return [];
  // First whitespace-delimited token after the slash is the filter.
  const head = draft.slice(1).split(/\s/, 1)[0] ?? "";
  // Once the user has typed args (a space), don't keep filtering — the menu
  // is for picking a command name only.
  if (draft.length > head.length + 1) return [];
  const q = head.toLowerCase();
  return entries
    .filter((e) => e.name.slice(1).toLowerCase().startsWith(q))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function nextActiveIndex(active: number, len: number, dir: 1 | -1): number {
  if (len === 0) return 0;
  return ((active + dir) % len + len) % len;
}

export function SlashMenu({ entries, draft, onSelect, onDismiss }: SlashMenuProps): JSX.Element | null {
  const filtered = useMemo(() => filterEntries(entries, draft), [entries, draft]);
  const [active, setActive] = useState(0);

  // Reset active row whenever the visible set changes.
  useEffect(() => { setActive(0); }, [draft, entries]);

  useEffect(() => {
    if (filtered.length === 0) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowDown") {
        setActive((a) => nextActiveIndex(a, filtered.length, 1));
        e.preventDefault();
      } else if (e.key === "ArrowUp") {
        setActive((a) => nextActiveIndex(a, filtered.length, -1));
        e.preventDefault();
      } else if (e.key === "Enter") {
        const pick = filtered[active];
        if (pick) {
          onSelect(pick);
          e.preventDefault();
        }
      } else if (e.key === "Escape") {
        if (onDismiss) {
          onDismiss();
          e.preventDefault();
        }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); };
  }, [filtered, active, onSelect, onDismiss]);

  if (filtered.length === 0) return null;

  return (
    <div
      data-testid="slash-menu"
      className="border-border bg-background absolute bottom-full left-0 mb-1 max-h-64 w-full overflow-auto rounded-md border shadow"
    >
      {filtered.map((e, i) => (
        <div
          key={e.id}
          data-testid={`slash-row-${e.id}`}
          aria-selected={i === active}
          className={`px-3 py-2 text-sm ${i === active ? "bg-muted" : ""}`}
          onMouseDown={(ev) => { ev.preventDefault(); onSelect(e); }}
          onMouseEnter={() => setActive(i)}
        >
          <div className="flex items-baseline gap-2">
            <span className="font-mono">{e.name}</span>
            <span className="text-muted-foreground text-xs">{e.source}</span>
            {e.argument_hint && <span className="text-muted-foreground text-xs">{e.argument_hint}</span>}
          </div>
          {e.description && <div className="text-muted-foreground text-xs">{e.description}</div>}
        </div>
      ))}
    </div>
  );
}
