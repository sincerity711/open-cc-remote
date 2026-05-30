import { useEffect, useMemo, useRef, useState } from "react";
import type { SlashEntry } from "@cc-remote/proto";
import { cn } from "../../lib/utils";

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

const SOURCE_LABELS: Record<SlashEntry["source"], string> = {
  builtin: "built-in",
  user: "user",
  project: "project",
  skill: "skill",
};

/**
 * Floating "/" autocomplete that appears above the composer. Renders a
 * filtered, keyboard-navigable list of registered commands.
 *
 * Visual contract:
 *   - Sheet-style popover (rounded-lg, soft elevation) — distinct from the
 *     composer chrome below it so the menu reads as overlay, not extension
 *     of the input.
 *   - Each row leads with the command name in mono, source as a small chip
 *     on the right, description below in muted text. Argument hint follows
 *     the name on the same line, also mono and dimmed, so the user can see
 *     the full call shape at a glance.
 *   - Active row gets a subtle primary tint + left accent bar so eye-scan
 *     and keyboard nav line up.
 */
export function SlashMenu({ entries, draft, onSelect, onDismiss }: SlashMenuProps): JSX.Element | null {
  const filtered = useMemo(() => filterEntries(entries, draft), [entries, draft]);
  const [active, setActive] = useState(0);
  // Refs for keyboard-driven scroll-into-view. We keep one ref per visible
  // row so when ↑/↓ moves `active` past the menu's own viewport, the
  // newly-selected row scrolls into view inside the popover (not the
  // outer page).
  const rowRefs = useRef<(HTMLLIElement | null)[]>([]);

  // Reset active row whenever the visible set changes.
  useEffect(() => { setActive(0); }, [draft, entries]);

  // Whenever active changes, scroll the corresponding row into view.
  // `block: "nearest"` so the menu only scrolls when active actually
  // crosses an edge — typing past 5 rows doesn't yank the top of the
  // menu away while the user is still scanning.
  useEffect(() => {
    const el = rowRefs.current[active];
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [active, filtered.length]);

  useEffect(() => {
    if (filtered.length === 0) return;
    // If the user has typed a complete command name that exactly matches a
    // single entry, get out of the way: Enter should submit the form, not
    // re-fill the same name. Without this, the menu's Enter handler steals
    // every submit even after the user already picked the command they want.
    const exactSingleMatch =
      filtered.length === 1 && draft.trim() === filtered[0]!.name;
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowDown") {
        setActive((a) => nextActiveIndex(a, filtered.length, 1));
        e.preventDefault();
      } else if (e.key === "ArrowUp") {
        setActive((a) => nextActiveIndex(a, filtered.length, -1));
        e.preventDefault();
      } else if (e.key === "Enter" && !exactSingleMatch) {
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
  }, [filtered, active, draft, onSelect, onDismiss]);

  if (filtered.length === 0) return null;
  // Hide the menu sheet itself once the draft exactly matches a single
  // entry — there's nothing more to pick. The keyboard handler above
  // also no-ops on Enter for the same case so submit can flow through.
  if (filtered.length === 1 && draft.trim() === filtered[0]!.name) return null;

  return (
    <div
      data-testid="slash-menu"
      role="listbox"
      className={cn(
        // Floats above the composer; the parent <form> uses `relative` so
        // bottom-full anchors to the input, not the page.
        "border-border bg-elevated absolute bottom-full left-0 right-0 z-30 mb-2 max-h-72 overflow-auto rounded-lg border shadow-sheet cc-enter",
      )}
    >
      <div className="border-border bg-muted/40 flex items-center justify-between border-b px-3 py-1.5">
        <span className="text-tertiary-foreground text-[10px] font-semibold uppercase tracking-[0.14em]">
          Slash commands
        </span>
        <span className="text-tertiary-foreground text-[11px]">
          {filtered.length} {filtered.length === 1 ? "match" : "matches"}
        </span>
      </div>
      <ul className="py-1">
        {filtered.map((e, i) => {
          const isActive = i === active;
          return (
            <li
              key={e.id}
              ref={(el) => {
                rowRefs.current[i] = el;
              }}
              data-testid={`slash-row-${e.id}`}
              role="option"
              aria-selected={isActive}
              className={cn(
                "relative flex cursor-pointer items-start gap-3 px-3 py-2 cc-transition-state",
                isActive
                  ? "bg-primary-subtle"
                  : "hover:bg-muted/40",
              )}
              onMouseDown={(ev) => { ev.preventDefault(); onSelect(e); }}
              onMouseEnter={() => setActive(i)}
            >
              {isActive && (
                <span
                  aria-hidden
                  className="bg-primary absolute inset-y-1 left-0 w-[3px] rounded-r-full"
                />
              )}
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-baseline gap-2">
                  <span className={cn(
                    "font-mono text-[13px] font-semibold",
                    isActive ? "text-primary" : "text-foreground",
                  )}>
                    {e.name}
                  </span>
                  {e.argument_hint && (
                    <span className="text-tertiary-foreground font-mono text-[12px]">
                      {e.argument_hint}
                    </span>
                  )}
                </span>
                {e.description && (
                  <span className="text-muted-foreground mt-0.5 block text-[12px] leading-snug">
                    {e.description}
                  </span>
                )}
              </span>
              <span
                className={cn(
                  "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
                  e.source === "builtin" &&
                    "border-border bg-muted text-muted-foreground",
                  e.source === "user" &&
                    "border-primary/30 bg-primary-subtle text-primary",
                  e.source === "project" &&
                    "border-success/30 bg-success-subtle text-success",
                  e.source === "skill" &&
                    "border-warning/35 bg-warning-subtle text-warning",
                )}
              >
                {SOURCE_LABELS[e.source]}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="border-border bg-muted/40 flex items-center justify-end gap-3 border-t px-3 py-1.5 text-tertiary-foreground text-[11px]">
        <span>
          <kbd className="border-border bg-surface text-muted-foreground inline-flex h-4 items-center rounded border px-1 font-mono text-[10px]">↑↓</kbd>
          <span className="ml-1">navigate</span>
        </span>
        <span>
          <kbd className="border-border bg-surface text-muted-foreground inline-flex h-4 items-center rounded border px-1 font-mono text-[10px]">↵</kbd>
          <span className="ml-1">select</span>
        </span>
        <span>
          <kbd className="border-border bg-surface text-muted-foreground inline-flex h-4 items-center rounded border px-1 font-mono text-[10px]">esc</kbd>
          <span className="ml-1">dismiss</span>
        </span>
      </div>
    </div>
  );
}
