import { useEffect, useState } from "react";
import { ArrowLeft, Send, X } from "lucide-react";
import type { PwaPermissionRequest } from "@cc-remote/proto";
import { Button } from "../components/ui/button";
import { StatusChip } from "./primitives/StatusChip";
import { SessionTimeline } from "./timeline/SessionTimeline";
import type { TimelineEvent } from "./timeline/types";

export interface SessionViewProps {
  header: { name: string; model: string | null; cwd: string; online: boolean };
  items: TimelineEvent[];
  composerBlocked: boolean;
  pendingPermissionInThisSession?: PwaPermissionRequest;
  chatError?: string;
  connected?: boolean;
  idle?: boolean;
  onLoadEarlier: () => void;
  onSendChat: (content: string) => void;
  onOpenPermission: (request_id: string) => void;
  onBack: () => void;
}

export function SessionView({
  header,
  items,
  composerBlocked,
  pendingPermissionInThisSession,
  chatError,
  connected = true,
  idle = false,
  onLoadEarlier,
  onSendChat,
  onOpenPermission,
  onBack,
}: SessionViewProps) {
  const [draft, setDraft] = useState("");
  const [queue, setQueue] = useState<string[]>([]);

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    const t = draft.trim();
    if (!t) return;
    if (!connected) {
      setQueue((q) => [...q, t]);
    } else {
      onSendChat(t);
    }
    setDraft("");
  };

  useEffect(() => {
    if (connected && queue.length > 0) {
      for (const msg of queue) onSendChat(msg);
      setQueue([]);
    }
  }, [connected, queue, onSendChat]);

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
          onLoadEarlier={onLoadEarlier}
          onOpenPermission={onOpenPermission}
        />
      </div>

      <div className="border-border bg-surface border-t p-3 pb-[calc(12px+env(safe-area-inset-bottom))]">
        {!connected && (
          <div
            className="bg-danger-subtle text-danger mb-2 flex items-center justify-between gap-2 rounded-md px-3 py-2 text-xs"
            data-testid="connection-banner"
          >
            <span>Connection lost — messages will retry when reconnected.</span>
            {queue.length > 0 && (
              <span data-testid="queued-count">{queue.length} queued</span>
            )}
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
        <form className="flex gap-2" onSubmit={handleSend}>
          <input
            className="border-border bg-muted focus:border-ring focus:ring-ring/30 disabled:text-disabled h-11 min-w-0 flex-1 rounded-md border px-3 text-base outline-none focus:ring-2"
            data-testid="chat-input"
            disabled={composerBlocked || !header.online}
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
            disabled={composerBlocked || !header.online || !draft.trim()}
            size="icon"
            type="submit"
          >
            <Send className="size-4" />
          </Button>
        </form>
      </div>
    </aside>
  );
}
