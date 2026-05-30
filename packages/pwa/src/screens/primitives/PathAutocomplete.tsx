import { useEffect, useMemo, useRef, useState } from "react";
import { File as FileIcon, Folder as FolderIcon } from "lucide-react";
import type { FsListEntry } from "@cc-remote/proto";
import { cn } from "../../lib/utils";
import { useFsList } from "../../hooks/useFsList";
import type { PwaFsListResult } from "@cc-remote/proto";
import { nextActiveIndex } from "./SlashMenu";

export type PathAutocompleteMode = "dirs" | "all";

type FsListSender = (
  daemon_id: string,
  parent: string,
  request_id: string,
  onResult: (frame: PwaFsListResult) => void,
) => () => void;

export interface PathAutocompleteProps {
  value: string;
  onChange(next: string): void;
  daemonId: string;
  /** When 'dirs', files are filtered out of suggestions (used by HomeScreen cwd picker). */
  mode: PathAutocompleteMode;
  /** Default text to seed the popover when value is empty. Defaults to "/". */
  baseHint?: string;
  /** Forwarded to the underlying input (className merged, value/onChange ignored). */
  inputProps?: React.InputHTMLAttributes<HTMLInputElement>;
  /** Test seam — defaults to useHub().sendFsList. Caller is responsible for stable identity. */
  sender: FsListSender;
}

/**
 * Split `value` into a parent directory (with trailing slash) and a
 * basename prefix. Empty value yields `parent="/"`, `prefix=""` — but
 * callers that want the popover to seed at a different default
 * directory (e.g. `~/`) pass the directory in via `baseHint` and the
 * caller of splitPath() should fall through to it.
 *
 * Pure helper — exposed for tests.
 */
export function splitPath(value: string): { parent: string; prefix: string } {
  if (!value) return { parent: "/", prefix: "" };
  const idx = value.lastIndexOf("/");
  if (idx < 0) return { parent: "/", prefix: value };
  return { parent: value.slice(0, idx + 1), prefix: value.slice(idx + 1) };
}

/**
 * Pure helper — filter + sort entries for the popover.
 *  - case-insensitive prefix match against `prefix`
 *  - dirs first, then by name
 *  - in mode="dirs", files are excluded
 *  - dotfiles are hidden unless the user is explicitly typing one
 *    (`prefix` starts with "."); $HOME on macOS holds dozens of
 *    `.cache` / `.config` / `.claude`-style folders that would
 *    otherwise drown out the actual project dirs.
 */
export function filterFsEntries(
  entries: FsListEntry[],
  prefix: string,
  mode: PathAutocompleteMode,
): FsListEntry[] {
  const q = prefix.toLowerCase();
  const showDotfiles = prefix.startsWith(".");
  const filtered = entries.filter((e) => {
    if (mode === "dirs" && !e.is_dir) return false;
    if (!showDotfiles && e.name.startsWith(".")) return false;
    return e.name.toLowerCase().startsWith(q);
  });
  filtered.sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return filtered;
}

/**
 * Normalize the parent path for the wire request. The fs_list frame
 * expects an absolute path with no trailing slash (except for the root).
 *
 * Pure helper — exposed for tests.
 */
export function normalizeParent(parent: string): string {
  if (!parent || parent === "/") return "/";
  return parent.endsWith("/") ? parent.slice(0, -1) : parent;
}

/**
 * Floating path-autocomplete popover. Visual chrome mirrors `SlashMenu`:
 * rounded sheet, kbd-hint footer, role="listbox", `cc-enter` animation.
 * The wrapper is `relative` so the popover anchors to the input.
 */
export function PathAutocomplete({
  value,
  onChange,
  daemonId,
  mode,
  baseHint,
  inputProps,
  sender,
}: PathAutocompleteProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  // Suppress popover when the user just accepted a file row — Tab/Enter
  // would otherwise reopen it on the next render. Cleared on next keystroke.
  const [suppress, setSuppress] = useState(false);

  // Split value normally; when value is empty, fall through to baseHint
  // so the popover seeds with that directory's contents instead of `/`
  // (which is typically outside the daemon's whitelist).
  const { parent, prefix } = useMemo(() => {
    if (value) return splitPath(value);
    if (baseHint) {
      const hint = baseHint.endsWith("/") ? baseHint : baseHint + "/";
      return { parent: hint, prefix: "" };
    }
    return { parent: "/", prefix: "" };
  }, [value, baseHint]);
  const fsParent = normalizeParent(parent);

  const { entries: rawEntries, status } = useFsList(daemonId, fsParent, sender);
  const filtered = useMemo(
    () => filterFsEntries(rawEntries, prefix, mode),
    [rawEntries, prefix, mode],
  );

  const [active, setActive] = useState(0);
  const rowRefs = useRef<(HTMLLIElement | null)[]>([]);

  useEffect(() => { setActive(0); }, [parent, prefix, mode]);
  useEffect(() => { setSuppress(false); }, [value]);

  useEffect(() => {
    const el = rowRefs.current[active];
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [active, filtered.length]);

  // Visibility rules:
  //  - mode="dirs": hide when there are 0 matches (the cwd picker should
  //    feel empty if nothing is left to disambiguate).
  //  - mode="all": hide when the value is empty (no @ token / no path yet).
  //  - Always hide while not focused (with blur delay handled below) or
  //    when explicitly suppressed by a recent file-accept.
  const hide =
    suppress ||
    !focused ||
    (mode === "dirs" && filtered.length === 0) ||
    (mode === "all" && value === "");

  const accept = (entry: FsListEntry) => {
    const next = parent + entry.name + (entry.is_dir ? "/" : "");
    onChange(next);
    if (!entry.is_dir) {
      setSuppress(true);
    }
    // Refocus to keep the keyboard cycle alive.
    inputRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (hide) return;
    if (e.key === "ArrowDown") {
      setActive((a) => nextActiveIndex(a, filtered.length, 1));
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      setActive((a) => nextActiveIndex(a, filtered.length, -1));
      e.preventDefault();
    } else if (e.key === "Enter") {
      const pick = filtered[active];
      if (pick) {
        accept(pick);
        e.preventDefault();
      }
    } else if (e.key === "Tab") {
      const pick = filtered[active];
      if (pick) {
        accept(pick);
        e.preventDefault();
      }
    } else if (e.key === "Escape") {
      setSuppress(true);
      e.preventDefault();
    }
  };

  const { className: extraClass, onChange: _ignore, value: _v, ...restInput } = inputProps ?? {};

  return (
    <div className="relative w-full min-w-0 flex-1">
      <input
        {...restInput}
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        // Delay so click handlers on rows fire before we hide.
        onBlur={() => setTimeout(() => setFocused(false), 100)}
        onKeyDown={onKeyDown}
        className={cn(
          "border-border bg-muted text-foreground focus:border-ring focus:ring-ring/30 h-11 min-w-0 flex-1 rounded-md border px-3 font-mono text-sm outline-none focus:ring-2",
          extraClass,
        )}
      />
      {!hide && (
        <div
          data-testid="path-autocomplete"
          role="listbox"
          className={cn(
            "border-border bg-elevated absolute left-0 right-0 top-full z-30 mt-1 max-h-72 overflow-auto rounded-lg border shadow-sheet cc-enter",
          )}
        >
          <div className="border-border bg-muted/40 flex items-center justify-between border-b px-3 py-1.5">
            <span className="text-tertiary-foreground text-[10px] font-semibold uppercase tracking-[0.14em]">
              {mode === "dirs" ? "Folders" : "Path"}
            </span>
            <span className="text-tertiary-foreground text-[11px]">
              {status === "loading"
                ? "loading…"
                : status === "error"
                  ? "error"
                  : `${filtered.length} ${filtered.length === 1 ? "match" : "matches"}`}
            </span>
          </div>
          {filtered.length > 0 ? (
            <ul className="py-1">
              {filtered.map((e, i) => {
                const isActive = i === active;
                return (
                  <li
                    key={e.name}
                    ref={(el) => {
                      rowRefs.current[i] = el;
                    }}
                    data-testid={e.is_dir ? "folder-suggestion" : "file-suggestion"}
                    data-name={e.name}
                    role="option"
                    aria-selected={isActive}
                    className={cn(
                      "relative flex cursor-pointer items-center gap-3 px-3 py-2 cc-transition-state",
                      isActive ? "bg-primary-subtle" : "hover:bg-muted/40",
                    )}
                    onMouseDown={(ev) => {
                      ev.preventDefault();
                      accept(e);
                    }}
                    onMouseEnter={() => setActive(i)}
                  >
                    {isActive && (
                      <span
                        aria-hidden
                        className="bg-primary absolute inset-y-1 left-0 w-[3px] rounded-r-full"
                      />
                    )}
                    {e.is_dir ? (
                      <FolderIcon className="text-muted-foreground size-4 shrink-0" />
                    ) : (
                      <FileIcon className="text-muted-foreground size-4 shrink-0" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn(
                          "truncate font-mono text-[13px] font-semibold",
                          isActive ? "text-primary" : "text-foreground",
                        )}
                      >
                        {e.name}
                        {e.is_dir ? "/" : ""}
                      </span>
                    </span>
                    <span
                      className={cn(
                        "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
                        e.is_dir
                          ? "border-primary/30 bg-primary-subtle text-primary"
                          : "border-border bg-muted text-muted-foreground",
                      )}
                    >
                      {e.is_dir ? "dir" : "file"}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="text-muted-foreground px-3 py-3 text-[12px]">
              {status === "loading" ? "…" : status === "error" ? "Couldn't list directory." : "No matches."}
            </div>
          )}
          <div className="border-border bg-muted/40 text-tertiary-foreground flex items-center justify-end gap-3 border-t px-3 py-1.5 text-[11px]">
            <span>
              <kbd className="border-border bg-surface text-muted-foreground inline-flex h-4 items-center rounded border px-1 font-mono text-[10px]">↑↓</kbd>
              <span className="ml-1">navigate</span>
            </span>
            <span>
              <kbd className="border-border bg-surface text-muted-foreground inline-flex h-4 items-center rounded border px-1 font-mono text-[10px]">↵</kbd>
              <span className="ml-1">select</span>
            </span>
            <span>
              <kbd className="border-border bg-surface text-muted-foreground inline-flex h-4 items-center rounded border px-1 font-mono text-[10px]">tab</kbd>
              <span className="ml-1">accept</span>
            </span>
            <span>
              <kbd className="border-border bg-surface text-muted-foreground inline-flex h-4 items-center rounded border px-1 font-mono text-[10px]">esc</kbd>
              <span className="ml-1">dismiss</span>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
