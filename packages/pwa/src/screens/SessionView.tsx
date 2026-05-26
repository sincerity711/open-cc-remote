import { useState } from "react";
import { ArrowLeft, Send, X } from "lucide-react";
import type { PwaPermissionRequest, SlashEntry } from "@cc-remote/proto";
import { Button } from "../components/ui/button";
import { StatusChip } from "./primitives/StatusChip";
import { SessionTimeline } from "./timeline/SessionTimeline";
import type { RenderItem } from "./timeline/types";
import type { PendingCommand } from "../hooks/pendingCommands";
import { SlashMenu, filterEntries } from "./primitives/SlashMenu";

export interface SessionViewProps {
  header: { name: string; model: string | null; cwd: string; online: boolean };
  items: RenderItem[];
  composerBlocked: boolean;
  pendingPermissionInThisSession?: PwaPermissionRequest;
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
  onMarkSeen?: (offset: number) => void;
  onLoadEarlier: () => void;
  onSendChat: (content: string) => void;
  onSendCliCommand?: (text: string) => void;
  onOpenPermission: (request_id: string) => void;
  onBack: () => void;
  onDismissPendingCommand?: (id: string) => void;
}

export function SessionView({
  header,
  items,
  composerBlocked,
  pendingPermissionInThisSession,
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
  onMarkSeen,
  onLoadEarlier,
  onSendChat,
  onSendCliCommand,
  onOpenPermission,
  onBack,
  onDismissPendingCommand,
}: SessionViewProps) {
  const [draft, setDraft] = useState("");

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
            <p className="text-muted-foreground truncate font-mono text-xs">
              {header.cwd}
              {header.model ? ` · ${header.model}` : ""}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <StatusChip
            label={header.online ? "Online" : "Offline"}
            tone={header.online ? "online" : "offline"}
          />
          <Button aria-label="Close" onClick={onBack} size="icon" variant="ghost">
            <X className="size-4" />
          </Button>
        </div>
      </header>

      <div className="flex flex-1 flex-col overflow-hidden" data-testid="chat-log">
        <SessionTimeline
          items={items}
          idle={idle}
          hasMoreEarlier={hasMoreEarlier}
          historyLoading={historyLoading}
          historyTimedOut={historyTimedOut}
          onLoadEarlier={onLoadEarlier}
          onOpenPermission={onOpenPermission}
          maxOffset={maxOffset}
          unreadCount={unreadCount}
          onMarkSeen={onMarkSeen}
        />
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
        {composerBlocked && pendingPermissionInThisSession && (
          <div className="bg-warning-subtle text-warning mb-2 flex items-center justify-between gap-2 rounded-md px-3 py-2 text-sm">
            <span>Permission required before Claude can continue.</span>
            <Button
              onClick={() => onOpenPermission(pendingPermissionInThisSession.request_id)}
              size="sm"
              variant="secondary"
            >
              Review
            </Button>
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
            }}
          />
          <input
            className="border-border bg-muted focus:border-ring focus:ring-ring/30 disabled:text-disabled h-11 min-w-0 flex-1 rounded-md border px-3 text-base outline-none focus:ring-2"
            data-testid="chat-input"
            disabled={composerDisabled}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={
              composerBlocked
                ? "Waiting for permission"
                : header.online
                  ? "Message Claude…"
                  : "session offline"
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
              <span className="animate-spin" data-testid="send-spinner">…</span>
            ) : (
              <Send className="size-4" />
            )}
          </Button>
        </form>
      </div>
    </aside>
  );
}
