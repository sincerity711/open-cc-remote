import { useEffect, useMemo, useState } from "react";
import { useHub, eventKey } from "./ws.ts";
import { consumeFragment, getBearer, loginUrl, clearBearer } from "./auth.ts";
import { SessionView } from "./screens/SessionView";
import { useSessionTimeline } from "./hooks/useSessionTimeline";
import { PermissionBanner } from "./PermissionBanner.tsx";
import { registerPushSubscription } from "./push.ts";
import { Settings } from "./Settings.tsx";
import { computeDaemonViewModels, totalPendingApprovals } from "./lib/daemonViewModel";
import { AppShell } from "./screens/AppShell";
import { HomeScreen } from "./screens/HomeScreen";
import { useDevice } from "./hooks/useMediaQuery";

const HUB_URL = (import.meta.env.VITE_HUB_URL as string) ?? "ws://localhost:7745";

interface Selected { daemon_id: string; session_id: string }

export function RealApp() {
  const [bearer, setBearer] = useState<string | null>(null);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    consumeFragment();
    setBearer(getBearer());
  }, []);

  useEffect(() => {
    if (!bearer) return;
    const vapid = (import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined) ?? null;
    registerPushSubscription(HUB_URL, bearer, vapid).then((r) => {
      if (!r.registered) {
        console.log("[cc-remote] push not registered:", r.reason);
      } else {
        console.log("[cc-remote] push subscribed");
      }
    }).catch((e) => {
      console.error("[cc-remote] push registration failed:", e);
    });
  }, [bearer]);

  const hub = useHub(HUB_URL, bearer);
  const { connected, daemons, events, pendingPermissions, sendPermissionReply, completedCounts, idleSessions, chatErrors } = hub;
  const sessionTimeline = useSessionTimeline(hub, selected);

  const device = useDevice();
  const daemonModels = useMemo(
    () => computeDaemonViewModels({
      daemons,
      events,
      pendingPermissions,
      completedCounts,
      idleSessions,
    }),
    [daemons, events, pendingPermissions, completedCounts, idleSessions],
  );
  const pendingApprovalsCount = totalPendingApprovals(pendingPermissions);
  const topPending = Object.values(pendingPermissions)[0];
  const topPendingPreview = topPending
    ? {
        daemonHostname:
          daemons.find((d) => d.daemon_id === topPending.daemon_id)?.hostname ??
          topPending.daemon_id,
        sessionName: topPending.session_id,
        tool: topPending.tool,
        commandSummary: topPending.args_summary,
      }
    : undefined;

  if (!bearer) {
    return (
      <main className="bg-background flex h-dvh items-center justify-center p-6">
        <div className="max-w-sm space-y-3 text-center">
          <h1 className="text-2xl font-semibold">cc-remote</h1>
          <p className="text-muted-foreground">You're not signed in.</p>
          <a
            className="bg-primary text-primary-foreground inline-block rounded-md px-4 py-2 text-sm font-semibold"
            href={loginUrl(HUB_URL)}
          >
            Sign in
          </a>
        </div>
      </main>
    );
  }

  const selectedChatError = selected ? chatErrors[eventKey(selected.daemon_id, selected.session_id)] : undefined;
  const selectedDaemon = selected ? daemons.find((d) => d.daemon_id === selected.daemon_id) : undefined;
  const selectedSession = selected
    ? selectedDaemon?.sessions.find((s) => s.session_id === selected.session_id)
    : undefined;

  return (
    <>
      <PermissionBanner pending={pendingPermissions} onReply={sendPermissionReply} />
      <AppShell
        device={device}
        connected={connected}
        pendingApprovalsCount={pendingApprovalsCount}
        onOpenSettings={() => setShowSettings(true)}
        onOpenPermission={() => {
          // Wired to PermissionSurface in Task 8.
        }}
        onSignOut={() => { clearBearer(); setBearer(null); }}
        sessionActiveOnMobile={!!selected}
        home={
          <HomeScreen
            daemons={daemonModels}
            pendingApprovalsCount={pendingApprovalsCount}
            topPendingPreview={topPendingPreview}
            selectedSessionId={selected?.session_id}
            onSelectSession={(daemon_id, session_id) => setSelected({ daemon_id, session_id })}
            onStartSession={(daemon_id, cwd) => hub.startSession(daemon_id, cwd)}
            onKillSession={(daemon_id, session_id) => hub.killSession(daemon_id, session_id)}
            onOpenPermission={() => {
              // Wired to PermissionSurface in Task 8.
            }}
          />
        }
        session={
          selected ? (
            <SessionView
              header={{
                name: selectedSession?.session_id ?? selected.session_id,
                model: selectedSession?.model ?? null,
                cwd: selectedSession?.cwd ?? "",
                online: sessionTimeline.online,
              }}
              items={sessionTimeline.items}
              composerBlocked={sessionTimeline.composerBlocked}
              pendingPermissionInThisSession={sessionTimeline.pendingInThisSession}
              chatError={selectedChatError}
              onLoadEarlier={sessionTimeline.loadEarlier}
              onSendChat={(content) => hub.sendChat(selected.daemon_id, selected.session_id, content)}
              onOpenPermission={(request_id) => {
                const req = pendingPermissions[request_id];
                if (req) sendPermissionReply(req, "allow");
              }}
              onBack={() => setSelected(null)}
            />
          ) : undefined
        }
      />
      {showSettings && bearer && (
        <Settings hubUrl={HUB_URL} bearer={bearer} onClose={() => setShowSettings(false)} />
      )}
    </>
  );
}
