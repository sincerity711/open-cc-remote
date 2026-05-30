import { useRef, useState } from "react";
import { ArrowLeft, Send, X } from "lucide-react";
import type { PwaPermissionRequest, SlashEntry, PwaFsListResult, SessionState as WireSessionState } from "@cc-remote/proto";
import { Button } from "../components/ui/button";
import { StatusChip } from "./primitives/StatusChip";
import { ClaudeAvatar } from "./primitives/ClaudeAvatar";
import { TypingIndicator } from "./primitives/TypingIndicator";
import { SessionTimeline } from "./timeline/SessionTimeline";
import type { RenderItem } from "./timeline/types";
import type { PendingCommand } from "../hooks/pendingCommands";
import { SlashMenu } from "./primitives/SlashMenu";
import { InlinePermissionCard } from "./primitives/InlinePermissionCard";
import { MentionAutocomplete, findMentionAtCursor } from "./primitives/MentionAutocomplete";

type FsListSender = (
  daemon_id: string,
  parent: string,
  request_id: string,
  onResult: (frame: PwaFsListResult) => void,
) => () => void;

export interface SessionViewProps {
  header: {
    name: string;
    model: string | null;
    cwd: string;
    online: boolean;
    /** Daemon FSM state (working|waiting|idle). Absent = legacy / not yet known. */
    state?: WireSessionState;
  };
  items: RenderItem[];
  composerBlocked: boolean;
  pendingPermissionInThisSession?: PwaPermissionRequest;
  /** PendingCommand keyed on the request_id, set while the daemon ack is in flight. */
  pendingPermissionReply?: PendingCommand;
  chatError?: string;
  connected?: boolean;
  idle?: boolean;
  hasMoreEarlier?: boolean;
  historyLoading?: boolean;
  historyTimedOut?: boolean;
  maxOffset?: number;
  unreadCount?: number;
  pendingChatSend?: PendingCommand;
  slashEntries?: SlashEntry[];
  /** Daemon owning this session — passed to MentionAutocomplete for fs_list. */
  daemonId?: string;
  /** Hub fs_list sender — when provided alongside daemonId, enables @-mention path completion. */
  fsListSender?: FsListSender;
  onMarkSeen?: (offset: number) => void;
  onLoadEarlier: () => void;
  onSendChat: (content: string) => void;
  onSendCliCommand?: (text: string) => void;
  /** Decision handler for the inline permission card. Wired by RealApp. */
  onSendPermissionReply?: (decision: "allow" | "deny") => void;
  onBack: () => void;
  onDismissPendingCommand?: (id: string) => void;
}

export function SessionView({
  header,
  items,
  composerBlocked,
  pendingPermissionInThisSession,
  pendingPermissionReply,
  chatError,
  connected = true,
  idle = false,
  hasMoreEarlier = true,
  historyLoading,
  historyTimedOut,
  maxOffset,
  unreadCount,
  pendingChatSend,
  slashEntries = [],
  daemonId,
  fsListSender,
  onMarkSeen,
  onLoadEarlier,
  onSendChat,
  onSendCliCommand,
  onSendPermissionReply,
  onBack,
  onDismissPendingCommand,
}: SessionViewProps) {
  const [draft, setDraft] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const setDraftAndCursor = (next: string, nextCursor: number) => {
    setDraft(next);
    setCursor(nextCursor);
    // Restore caret position after React re-renders the controlled input.
    queueMicrotask(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        try { el.setSelectionRange(nextCursor, nextCursor); } catch {}
      }
    });
  };

  // Show mention popover only when we have a daemon + sender and the
  // composer isn't being driven by a leading-slash command. Spec
  // requires SlashMenu and MentionAutocomplete never coexist.
  const slashActive = draft.startsWith("/");
  const mentionEligible =
    !!daemonId && !!fsListSender && !slashActive &&
    findMentionAtCursor(draft, cursor) !== null;

  const isSlashSubmit = (text: string): boolean => {
    if (!text.startsWith("/")) return false;
    const head = text.split(/\s+/, 1)[0] ?? "";
    return slashEntries.some((e) => e.name === head);
  };

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    const t = draft.trim();
    if (!t) return;
    if (isSlashSubmit(t) && onSendCliCommand) {
      onSendCliCommand(t);
    } else {
      onSendChat(t);
    }
    setDraft("");
    setCursor(0);
  };

  const sending = pendingChatSend?.status === "pending";
  const sendFailed =
    pendingChatSend?.status === "failed" || pendingChatSend?.status === "timed_out";
  const composerDisabled = composerBlocked || !header.online || sending || !connected;

  return (
    <aside
      className="bg-surface border-border flex h-full min-w-0 flex-col border-l"
      data-testid="session-view"
    >
      <header className="border-border flex items-center justify-between gap-2 border-b p-3">
        <div className="flex min-w-0 items-center gap-2">
          <Button aria-label="Back" onClick={onBack} size="icon" variant="ghost">
            <ArrowLeft className="size-4" />
          </Button>
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold">{header.name}</h2>
            <p className="text-tertiary-foreground truncate font-mono text-[13px]">
              {header.cwd}
              {header.model ? ` · ${header.model}` : ""}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!header.online ? (
            <StatusChip label="Offline" tone="offline" />
          ) : header.state === "working" ? (
            <StatusChip label="Working" tone="working" />
          ) : header.state === "waiting" ? (
            <StatusChip label="Waiting" tone="waiting" />
          ) : header.state === "idle" ? (
            <StatusChip label="Idle" tone="idle" />
          ) : (
            <StatusChip label="Online" tone="online" />
          )}
          <Button aria-label="Close" onClick={onBack} size="icon" variant="ghost">
            <X className="size-4" />
          </Button>
        </div>
      </header>

      <div className="flex flex-1 flex-col overflow-hidden" data-testid="chat-log">
        {pendingPermissionInThisSession && onSendPermissionReply && (
          <div className="px-3 pt-3">
            <InlinePermissionCard
              request={pendingPermissionInThisSession}
              pendingReply={pendingPermissionReply}
              onDecide={onSendPermissionReply}
            />
          </div>
        )}
        <SessionTimeline
          items={items}
          idle={idle}
          hasMoreEarlier={hasMoreEarlier}
          historyLoading={historyLoading}
          historyTimedOut={historyTimedOut}
          onLoadEarlier={onLoadEarlier}
          maxOffset={maxOffset}
          unreadCount={unreadCount}
          onMarkSeen={onMarkSeen}
        />
        {header.state === "working" && (
          <div
            className="flex items-center gap-2.5 px-3 pb-2 cc-enter"
            data-testid="thinking-row"
          >
            <ClaudeAvatar size="sm" />
            <span className="text-muted-foreground text-[13px] italic">
              Claude is thinking
            </span>
            <TypingIndicator className="text-muted-foreground" />
          </div>
        )}
      </div>

      <div className="border-border bg-surface border-t p-3 pb-[calc(12px+env(safe-area-inset-bottom))]">
        {!connected && (
          <div
            className="bg-danger-subtle text-danger mb-2 rounded-md px-3 py-2 text-xs"
            data-testid="connection-banner"
          >
            Connection lost. Reconnect before sending.
          </div>
        )}
        {chatError && (
          <div className="bg-danger-subtle text-danger mb-2 rounded-md px-3 py-2 text-xs">
            chat error: {chatError}
          </div>
        )}
        {sending && (
          <div
            className="text-muted-foreground mb-2 flex items-center gap-2 rounded-md px-3 py-2 text-sm"
            data-testid="chat-pending-row"
          >
            <span className="animate-pulse">●</span>
            <span>Sending message…</span>
          </div>
        )}
        {sendFailed && pendingChatSend && (
          <div
            className="bg-danger-subtle text-danger mb-2 flex items-center justify-between gap-2 rounded-md px-3 py-2 text-sm"
            data-testid="chat-send-failure"
            role="alert"
          >
            <span>
              {pendingChatSend.status === "timed_out"
                ? "Message not confirmed. Try again."
                : `Message not confirmed: ${pendingChatSend.error ?? "send failed"}`}
            </span>
            {onDismissPendingCommand && (
              <Button
                onClick={() => onDismissPendingCommand(pendingChatSend.id)}
                size="sm"
                variant="ghost"
              >
                Dismiss
              </Button>
            )}
          </div>
        )}
        <form className="relative flex gap-2" onSubmit={handleSend}>
          <SlashMenu
            entries={slashEntries}
            draft={draft}
            onSelect={(entry) => {
              const head = entry.name + " ";
              setDraft(head);
              setCursor(head.length);
            }}
            onDismiss={() => {
              // Wipe the leading "/" so the menu actually closes — otherwise
              // it re-derives `filtered` from `draft` and reappears.
              setDraft("");
              setCursor(0);
            }}
          />
          {mentionEligible && daemonId && fsListSender && (
            <MentionAutocomplete
              draft={draft}
              cursor={cursor}
              onChange={setDraftAndCursor}
              daemonId={daemonId}
              cwd={header.cwd}
              sender={fsListSender}
            />
          )}
          <input
            ref={inputRef}
            className="border-border bg-muted focus:border-ring focus:ring-ring/30 disabled:text-disabled h-11 min-w-0 flex-1 rounded-md border px-3 text-base outline-none focus:ring-2"
            data-testid="chat-input"
            disabled={composerDisabled}
            onChange={(e) => {
              setDraft(e.target.value);
              setCursor(e.target.selectionStart ?? e.target.value.length);
            }}
            onSelect={(e) => {
              const tgt = e.currentTarget;
              setCursor(tgt.selectionStart ?? tgt.value.length);
            }}
            onKeyUp={(e) => {
              const tgt = e.currentTarget;
              setCursor(tgt.selectionStart ?? tgt.value.length);
            }}
            onClick={(e) => {
              const tgt = e.currentTarget;
              setCursor(tgt.selectionStart ?? tgt.value.length);
            }}
            placeholder={
              composerBlocked
                ? "Waiting for permission"
                : !header.online
                  ? "session offline"
                  : sending
                    ? "Sending…"
                    : "Message Claude…"
            }
            value={draft}
          />
          <Button
            disabled={composerDisabled || !draft.trim()}
            size="icon"
            type="submit"
            aria-label="Send"
          >
            {sending ? (
              <span data-testid="send-spinner" className="inline-flex">
                <TypingIndicator />
              </span>
            ) : (
              <Send className="size-4" />
            )}
          </Button>
        </form>
      </div>
    </aside>
  );
}
