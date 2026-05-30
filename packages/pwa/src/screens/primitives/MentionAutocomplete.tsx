import { useEffect, useMemo, useRef, useState } from "react";
import { File as FileIcon, Folder as FolderIcon } from "lucide-react";
import type { FsListEntry, PwaFsListResult } from "@cc-remote/proto";
import { cn } from "../../lib/utils";
import { useFsList } from "../../hooks/useFsList";
import { nextActiveIndex } from "./SlashMenu";
import {
  filterFsEntries,
  normalizeParent,
} from "./PathAutocomplete";

type FsListSender = (
  daemon_id: string,
  parent: string,
  request_id: string,
  onResult: (frame: PwaFsListResult) => void,
) => () => void;

export interface MentionToken {
  /** Index in the draft where the @ sits. */
  start: number;
  /** Index just past the last non-whitespace character of the token. */
  end: number;
  /** The token text WITHOUT the leading @. e.g. "src/comp" for "@src/comp". */
  text: string;
}

/**
 * Find the @-token under the cursor. A token is "@" followed by a run
 * of non-whitespace characters; the cursor must sit somewhere inside
 * (start <= cursor <= end). Returns null when the cursor isn't on an
 * @-token.
 *
 * Pure helper — exposed for tests.
 */
export function findMentionAtCursor(draft: string, cursor: number): MentionToken | null {
  if (cursor < 0 || cursor > draft.length) return null;
  // Walk backwards to find @ or whitespace boundary.
  let i = cursor - 1;
  while (i >= 0 && !/\s/.test(draft[i]!)) {
    if (draft[i] === "@") {
      const start = i;
      // Walk forwards from cursor over the rest of the token.
      let j = cursor;
      while (j < draft.length && !/\s/.test(draft[j]!)) j += 1;
      return { start, end: j, text: draft.slice(start + 1, j) };
    }
    i -= 1;
  }
  return null;
}

/**
 * Resolve a mention token's text to the parent directory + basename
 * prefix that we should send to the daemon.
 *
 *   @/abs/path   → absolute /abs/path
 *   @./rel       → joined onto cwd
 *   @rel         → joined onto cwd
 *   @~/foo       → "~/foo" sent literally — daemon resolves home
 *
 * Pure helper — exposed for tests.
 */
export function resolveMentionPath(token: string, cwd: string): { parent: string; prefix: string } {
  let abs: string;
  if (token.startsWith("/")) {
    abs = token;
  } else if (token.startsWith("~")) {
    abs = token; // daemon resolves
  } else if (token.startsWith("./")) {
    abs = joinCwd(cwd, token.slice(2));
  } else {
    abs = joinCwd(cwd, token);
  }
  const idx = abs.lastIndexOf("/");
  if (idx < 0) {
    // No slash means everything is the basename prefix; fall back to "/"
    // for the parent so we still get top-level suggestions.
    return { parent: "/", prefix: abs };
  }
  return { parent: abs.slice(0, idx + 1) || "/", prefix: abs.slice(idx + 1) };
}

function joinCwd(cwd: string, rel: string): string {
  if (!cwd) return "/" + rel;
  return cwd.endsWith("/") ? cwd + rel : cwd + "/" + rel;
}

/**
 * Given the original draft + the token to replace + the new token text
 * (without the leading @), return the next draft string. Used for both
 * directory accept (keep token open) and file accept (close, append space).
 *
 * Pure helper — exposed for tests.
 */
export function replaceMentionToken(
  draft: string,
  token: MentionToken,
  newToken: string,
  trailingSpace: boolean,
): string {
  const before = draft.slice(0, token.start);
  const after = draft.slice(token.end);
  const replacement = "@" + newToken + (trailingSpace ? " " : "");
  return before + replacement + after;
}

/**
 * For an @-token whose user-visible text is `tokenText`, compute the
 * "tokenText" we should put back into the draft after accepting the
 * given entry. Mirrors splitPath: keep the directory portion of the
 * original token, swap in the entry's name. Dirs get a trailing slash.
 *
 * Pure helper.
 */
export function nextTokenText(tokenText: string, entry: FsListEntry): string {
  const idx = tokenText.lastIndexOf("/");
  const head = idx < 0 ? "" : tokenText.slice(0, idx + 1);
  return head + entry.name + (entry.is_dir ? "/" : "");
}

export interface MentionAutocompleteProps {
  draft: string;
  cursor: number;
  onChange(next: string, nextCursor: number): void;
  daemonId: string;
  cwd: string;
  sender: FsListSender;
}

/**
 * `@`-mention popover for the chat composer. Activates when the cursor
 * sits inside an @-prefixed token; otherwise renders nothing.
 */
export function MentionAutocomplete(props: MentionAutocompleteProps): JSX.Element | null {
  const { draft, cursor, onChange, daemonId, cwd, sender } = props;
  const token = useMemo(() => findMentionAtCursor(draft, cursor), [draft, cursor]);
  // Suppress popover until the user types again — used after a file accept.
  const [suppressed, setSuppressed] = useState(false);
  const lastDraftRef = useRef(draft);
  useEffect(() => {
    if (lastDraftRef.current !== draft) {
      setSuppressed(false);
      lastDraftRef.current = draft;
    }
  }, [draft]);

  const resolved = useMemo(
    () => (token ? resolveMentionPath(token.text, cwd) : null),
    [token, cwd],
  );
  const fsParent = resolved ? normalizeParent(resolved.parent) : "";

  const { entries: rawEntries, status } = useFsList(daemonId, fsParent, sender);
  const filtered = useMemo(
    () => (resolved ? filterFsEntries(rawEntries, resolved.prefix, "all") : []),
    [rawEntries, resolved],
  );

  const [active, setActive] = useState(0);
  useEffect(() => { setActive(0); }, [token?.start, token?.text]);

  useEffect(() => {
    if (!token || suppressed) return;
    function onKey(e: KeyboardEvent) {
      if (filtered.length === 0) return;
      if (e.key === "ArrowDown") {
        setActive((a) => nextActiveIndex(a, filtered.length, 1));
        e.preventDefault();
      } else if (e.key === "ArrowUp") {
        setActive((a) => nextActiveIndex(a, filtered.length, -1));
        e.preventDefault();
      } else if (e.key === "Enter" || e.key === "Tab") {
        const pick = filtered[active];
        if (!pick) return;
        const newToken = nextTokenText(token!.text, pick);
        const next = replaceMentionToken(draft, token!, newToken, !pick.is_dir);
        const nextCursor = token!.start + 1 + newToken.length + (pick.is_dir ? 0 : 1);
        onChange(next, nextCursor);
        if (!pick.is_dir) setSuppressed(true);
        e.preventDefault();
      } else if (e.key === "Escape") {
        setSuppressed(true);
        e.preventDefault();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); };
  }, [token, filtered, active, draft, onChange, suppressed]);

  if (!token || suppressed) return null;
  // mode="all" — but hide when there's nothing to show *and* we're not
  // still loading. Showing an empty popover hampers slash + free-typing.
  if (filtered.length === 0 && status !== "loading") return null;

  const accept = (e: FsListEntry) => {
    const newToken = nextTokenText(token.text, e);
    const next = replaceMentionToken(draft, token, newToken, !e.is_dir);
    const nextCursor = token.start + 1 + newToken.length + (e.is_dir ? 0 : 1);
    onChange(next, nextCursor);
    if (!e.is_dir) setSuppressed(true);
  };

  return (
    <div
      data-testid="mention-popover"
      role="listbox"
      className={cn(
        "border-border bg-elevated absolute bottom-full left-0 right-0 z-30 mb-2 max-h-72 overflow-auto rounded-lg border shadow-sheet cc-enter",
      )}
    >
      <div className="border-border bg-muted/40 flex items-center justify-between border-b px-3 py-1.5">
        <span className="text-tertiary-foreground text-[10px] font-semibold uppercase tracking-[0.14em]">
          Path mention
        </span>
        <span className="text-tertiary-foreground text-[11px]">
          {status === "loading"
            ? "loading…"
            : status === "error"
              ? "error"
              : `${filtered.length} ${filtered.length === 1 ? "match" : "matches"}`}
        </span>
      </div>
      <ul className="py-1">
        {filtered.map((e, i) => {
          const isActive = i === active;
          return (
            <li
              key={e.name}
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
  );
}
