import { Bell, Laptop, Settings } from "lucide-react";
import type React from "react";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { ClaudeCodeMark } from "./primitives/ClaudeCodeMark";
import { StatusChip } from "./primitives/StatusChip";

export type AppShellDevice = "mobile" | "tablet" | "desktop";

export interface AppShellProps {
  device: AppShellDevice;
  connected: boolean;
  pendingApprovalsCount: number;
  onOpenSettings: () => void;
  onOpenPermission: () => void;
  onSignOut: () => void;
  /** Side-by-side panes when device !== mobile. On mobile, one or the other. */
  home: React.ReactNode;
  session?: React.ReactNode;
  /** True on mobile when a session is selected so HomeScreen is hidden. */
  sessionActiveOnMobile?: boolean;
}

export function AppShell({
  device,
  connected,
  pendingApprovalsCount,
  onOpenSettings,
  onOpenPermission,
  onSignOut,
  home,
  session,
  sessionActiveOnMobile = false,
}: AppShellProps) {
  return (
    <div className="bg-background flex h-dvh flex-col">
      <header
        className="border-border bg-surface flex h-14 shrink-0 items-center justify-between border-b px-4"
        data-testid="app-shell-header"
      >
        <div className="flex items-center gap-2">
          <ClaudeCodeMark size="sm" />
          <span className="font-semibold">cc-remote</span>
        </div>
        <div className="flex items-center gap-2">
          <StatusChip
            label={connected ? "Connected" : "Reconnecting…"}
            tone={connected ? "online" : "error"}
          />
          {device === "desktop" && (
            <Button onClick={onSignOut} size="sm" variant="ghost">
              Sign out
            </Button>
          )}
          <Button
            aria-label="Open settings"
            onClick={onOpenSettings}
            size="icon"
            variant="ghost"
          >
            <Settings className="size-4" />
          </Button>
        </div>
      </header>

      <div
        className={cn(
          "flex min-h-0 flex-1",
          device === "desktop" && "grid grid-cols-[72px_370px_minmax(0,1fr)]",
          device === "tablet" && "grid grid-cols-[320px_minmax(0,1fr)]",
        )}
      >
        {device === "desktop" && (
          <DesktopNav
            pendingApprovalsCount={pendingApprovalsCount}
            onOpenPermission={onOpenPermission}
            onOpenSettings={onOpenSettings}
          />
        )}

        {device === "mobile" ? (
          <div className="min-w-0 flex-1">
            {sessionActiveOnMobile && session ? session : home}
          </div>
        ) : (
          <>
            <div className="min-w-0">{home}</div>
            <div className="min-w-0">
              {session ?? (
                <div className="bg-background flex h-full items-center justify-center">
                  <p className="text-muted-foreground text-sm">
                    Select a session to start.
                  </p>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function DesktopNav({
  pendingApprovalsCount,
  onOpenPermission,
  onOpenSettings,
}: {
  pendingApprovalsCount: number;
  onOpenPermission: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <nav className="border-border bg-surface flex flex-col items-center gap-3 border-r px-3 py-4">
      <button
        aria-label="Machines"
        className="text-foreground bg-muted flex size-11 items-center justify-center rounded-md"
      >
        <Laptop className="size-5" />
      </button>
      <button
        aria-label={`Permissions (${pendingApprovalsCount} pending)`}
        className="text-muted-foreground hover:bg-muted hover:text-foreground relative flex size-11 items-center justify-center rounded-md"
        onClick={onOpenPermission}
      >
        <Bell className="size-5" />
        {pendingApprovalsCount > 0 && (
          <span className="bg-warning text-warning-foreground absolute right-1 top-1 inline-flex size-4 items-center justify-center rounded-full text-[10px] font-bold">
            {pendingApprovalsCount}
          </span>
        )}
      </button>
      <button
        aria-label="Settings"
        className="text-muted-foreground hover:bg-muted hover:text-foreground flex size-11 items-center justify-center rounded-md"
        onClick={onOpenSettings}
      >
        <Settings className="size-5" />
      </button>
    </nav>
  );
}
