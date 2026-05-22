import { Bell, Laptop, Settings } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type React from "react";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { ClaudeCodeMark } from "./primitives/ClaudeCodeMark";
import { StatusChip } from "./primitives/StatusChip";

export type AppShellDevice = "mobile" | "tablet" | "desktop";

const HOME_WIDTH_KEY = "cc_remote_home_width_px";
const HOME_WIDTH_DEFAULT = 370;
const HOME_WIDTH_MIN = 280;
const HOME_WIDTH_MAX = 720;

function loadStoredHomeWidth(): number {
  if (typeof window === "undefined") return HOME_WIDTH_DEFAULT;
  const raw = localStorage.getItem(HOME_WIDTH_KEY);
  const parsed = raw ? Number(raw) : NaN;
  if (!Number.isFinite(parsed)) return HOME_WIDTH_DEFAULT;
  return Math.min(HOME_WIDTH_MAX, Math.max(HOME_WIDTH_MIN, parsed));
}

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
  const [homeWidth, setHomeWidth] = useState<number>(() => loadStoredHomeWidth());
  const dragStartRef = useRef<{ x: number; startWidth: number } | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    localStorage.setItem(HOME_WIDTH_KEY, String(homeWidth));
  }, [homeWidth]);

  const onHandlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragStartRef.current = { x: e.clientX, startWidth: homeWidth };
  };
  const onHandlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragStartRef.current) return;
    const dx = e.clientX - dragStartRef.current.x;
    const next = Math.min(
      HOME_WIDTH_MAX,
      Math.max(HOME_WIDTH_MIN, dragStartRef.current.startWidth + dx),
    );
    setHomeWidth(next);
  };
  const onHandlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    dragStartRef.current = null;
  };
  const onHandleDoubleClick = () => setHomeWidth(HOME_WIDTH_DEFAULT);

  const desktopGridCols = `72px ${homeWidth}px 6px minmax(0, 1fr)`;
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
          {device !== "desktop" && (
            <button
              aria-label={`Permissions (${pendingApprovalsCount} pending)`}
              className="text-muted-foreground hover:bg-muted hover:text-foreground relative inline-flex size-9 items-center justify-center rounded-md"
              onClick={onOpenPermission}
              type="button"
            >
              <Bell className="size-4" />
              {pendingApprovalsCount > 0 && (
                <span className="bg-warning text-warning-foreground absolute right-0.5 top-0.5 inline-flex size-4 items-center justify-center rounded-full text-[10px] font-bold">
                  {pendingApprovalsCount}
                </span>
              )}
            </button>
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
          device === "desktop" && "grid",
          device === "tablet" && "grid grid-cols-[320px_minmax(0,1fr)]",
        )}
        style={device === "desktop" ? { gridTemplateColumns: desktopGridCols } : undefined}
      >
        {device === "desktop" && (
          <DesktopNav
            pendingApprovalsCount={pendingApprovalsCount}
            onOpenPermission={onOpenPermission}
            onOpenSettings={onOpenSettings}
          />
        )}

        {device === "mobile" ? (
          <div className="min-h-0 min-w-0 flex-1">
            {sessionActiveOnMobile && session ? session : home}
          </div>
        ) : (
          <>
            <div className="min-h-0 min-w-0">{home}</div>
            {device === "desktop" && (
              <div
                aria-label="Resize home column"
                aria-orientation="vertical"
                className="bg-border hover:bg-primary/40 group relative cursor-col-resize touch-none select-none"
                onDoubleClick={onHandleDoubleClick}
                onPointerDown={onHandlePointerDown}
                onPointerMove={onHandlePointerMove}
                onPointerUp={onHandlePointerUp}
                onPointerCancel={onHandlePointerUp}
                role="separator"
                title="Drag to resize · double-click to reset"
              >
                {/* Wider invisible hit area for easier grabbing. */}
                <span className="absolute inset-y-0 -left-1 -right-1" />
              </div>
            )}
            <div className="min-h-0 min-w-0">
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
