import { useEffect, useMemo, useState } from "react";
import { useHub, eventKey } from "./hooks/useHub";
import { clearBearer, useAuth } from "./hooks/useAuth";
import { SessionView } from "./screens/SessionView";
import { useSessionTimeline } from "./hooks/useSessionTimeline";
import { registerPushSubscription } from "./push.ts";
import { SettingsDrawer, type Appearance } from "./screens/SettingsDrawer";
import { useDevices } from "./hooks/useDevices";
import { computeDaemonViewModels, totalPendingApprovals } from "./lib/daemonViewModel";
import { AppShell } from "./screens/AppShell";
import { HomeScreen } from "./screens/HomeScreen";
import { useDevice } from "./hooks/useMediaQuery";
import { usePermissionQueue } from "./hooks/usePermissionQueue";
import { PermissionSurface } from "./screens/PermissionSurface";
import { SignInScreen } from "./screens/SignInScreen";

const HUB_URL = (import.meta.env.VITE_HUB_URL as string) ?? "ws://localhost:7745";

interface Selected { daemon_id: string; session_id: string }

export function RealApp() {
  const { bearer, setBearer, signInHref, signOut } = useAuth(HUB_URL);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [authNotice, setAuthNotice] = useState<string | null>(null);

  useEffect(() => {
    if (bearer) setAuthNotice(null);
  }, [bearer]);

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

  const hub = useHub(HUB_URL, bearer, {
    onAuthFailure: () => {
      clearBearer();
      setBearer(null);
      setAuthNotice("Session expired, please sign in again.");
    },
  });
  const { connected, daemons, events, pendingPermissions, sendPermissionReply, completedCounts, chatErrors } = hub;
  const sessionTimeline = useSessionTimeline(hub, selected);

  const device = useDevice();
  const daemonModels = useMemo(
    () => computeDaemonViewModels({
      daemons,
      events,
      pendingPermissions,
      completedCounts,
    }),
    [daemons, events, pendingPermissions, completedCounts],
  );
  const permissionQueue = usePermissionQueue(pendingPermissions);
  const pendingApprovalsCount = totalPendingApprovals(pendingPermissions);
  const deviceData = useDevices(HUB_URL, bearer);
  const [appearance, setAppearance] = useState<Appearance>(() => {
    if (typeof window === "undefined") return "system";
    const stored = window.localStorage.getItem("cc_remote_appearance");
    return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const root = document.documentElement;
    const apply = (mode: Appearance) => {
      const dark =
        mode === "dark" ||
        (mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
      root.classList.toggle("dark", dark);
    };
    apply(appearance);
    window.localStorage.setItem("cc_remote_appearance", appearance);
    if (appearance === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const onChange = () => apply("system");
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    }
    return;
  }, [appearance]);
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
    return <SignInScreen loginHref={signInHref} notice={authNotice ?? undefined} />;
  }

  const selectedChatError = selected ? chatErrors[eventKey(selected.daemon_id, selected.session_id)] : undefined;
  const selectedDaemon = selected ? daemons.find((d) => d.daemon_id === selected.daemon_id) : undefined;
  const selectedSession = selected
    ? selectedDaemon?.sessions.find((s) => s.session_id === selected.session_id)
    : undefined;

  return (
    <>
      <AppShell
        device={device}
        connected={connected}
        pendingApprovalsCount={pendingApprovalsCount}
        onOpenSettings={() => setShowSettings(true)}
        onOpenPermission={permissionQueue.openSurface}
        onSignOut={() => signOut()}
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
            onOpenPermission={permissionQueue.openSurface}
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
              connected={connected}
              idle={sessionTimeline.idle}
              hasMoreEarlier={sessionTimeline.hasMoreEarlier}
              onLoadEarlier={sessionTimeline.loadEarlier}
              onSendChat={(content) => hub.sendChat(selected.daemon_id, selected.session_id, content)}
              onOpenPermission={() => permissionQueue.openSurface()}
              onBack={() => setSelected(null)}
            />
          ) : undefined
        }
      />
      {showSettings && bearer && (
        <SettingsDrawer
          device={device}
          account={{
            email: getEmailFromBearer(bearer) ?? "signed in",
            onSignOut: () => {
              signOut();
              setShowSettings(false);
            },
          }}
          devices={deviceData.devices}
          onRenameDevice={(id, name) => { void deviceData.rename(id, name); }}
          onRevokeDevice={(id) => { void deviceData.revoke(id); }}
          pushPrefs={deviceData.pushPrefs}
          onTogglePref={(key) => { void deviceData.togglePushPref(key); }}
          appearance={appearance}
          onSetAppearance={setAppearance}
          error={deviceData.error}
          onClose={() => setShowSettings(false)}
        />
      )}
      {permissionQueue.open && permissionQueue.active && (() => {
        const active = permissionQueue.active;
        return (
          <PermissionSurface
            request={active}
            daemonHostname={
              daemons.find((d) => d.daemon_id === active.daemon_id)?.hostname ??
              active.daemon_id
            }
            queueIndex={permissionQueue.queueIndex}
            queueSize={permissionQueue.queueSize}
            device={device}
            onAllow={() => {
              sendPermissionReply(active, "allow");
              permissionQueue.advance();
            }}
            onDeny={() => {
              sendPermissionReply(active, "deny");
              permissionQueue.advance();
            }}
            onClose={permissionQueue.closeSurface}
          />
        );
      })()}
      {permissionQueue.handledNotice && (
        <div
          className="bg-surface text-foreground border-border shadow-card fixed top-16 left-1/2 z-[60] -translate-x-1/2 rounded-md border px-3 py-2 text-sm"
          role="status"
        >
          Already handled on another device.
        </div>
      )}
    </>
  );
}

function getEmailFromBearer(bearer: string): string | null {
  try {
    const payload = bearer.split(".")[1];
    if (!payload) return null;
    const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    if (typeof json.email === "string") return json.email;
    if (typeof json.sub === "string") return json.sub;
    return null;
  } catch {
    return null;
  }
}
