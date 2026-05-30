import { useEffect, useMemo, useState } from "react";
import { useHub, eventKey } from "./hooks/useHub";
import { selectSlashInventory } from "./hooks/useSlashInventory";
import { clearBearer, useAuth } from "./hooks/useAuth";
import { SessionView } from "./screens/SessionView";
import { useSessionTimeline } from "./hooks/useSessionTimeline";
import { useLastSeen } from "./hooks/useLastSeen";
import { registerPushSubscription } from "./push.ts";
import { SettingsDrawer, type Appearance } from "./screens/SettingsDrawer";
import { useDaemons } from "./hooks/useDaemons";
import { usePushTopics } from "./hooks/usePushTopics";
import { usePairing } from "./hooks/usePairing";
import { computeDaemonViewModels } from "./lib/daemonViewModel";
import { AppShell } from "./screens/AppShell";
import { HomeScreen } from "./screens/HomeScreen";
import { useDevice } from "./hooks/useMediaQuery";
import { AskQuestionSurface } from "./screens/AskQuestionSurface";
import { SignInScreen } from "./screens/SignInScreen";
import type { PendingCommand } from "./hooks/pendingCommands";

function defaultHubUrl(): string {
  if (typeof window === "undefined") return "ws://localhost:17745";
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}`;
}
const HUB_URL = (import.meta.env.VITE_HUB_URL as string) || defaultHubUrl();

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
  const { connected, daemons, events, pendingPermissions, pendingQuestions, sendPermissionReply, sendAskAnswer, completedCounts, chatErrors, startSessionErrors, clearStartSessionError, pendingChatSendFor, dismissPendingCommand, pendingPermissionReplyFor, sendFsList } = hub;
  const { lastSeenOffsets, markSeen } = useLastSeen();
  const selectedKey = selected ? eventKey(selected.daemon_id, selected.session_id) : null;
  const sessionTimeline = useSessionTimeline(
    hub,
    selected,
    selectedKey ? lastSeenOffsets[selectedKey] : undefined,
  );

  const device = useDevice();
  const daemonModels = useMemo(
    () => computeDaemonViewModels({
      daemons,
      events,
      pendingPermissions,
      completedCounts,
      lastSeenOffsets,
    }),
    [daemons, events, pendingPermissions, completedCounts, lastSeenOffsets],
  );
  const daemonsHook = useDaemons(HUB_URL, bearer, showSettings);
  const pushHook = usePushTopics(HUB_URL, bearer);
  const pairingHook = usePairing(HUB_URL, bearer, daemonsHook.refresh);

  const pendingStartSessionByDaemon = useMemo(() => {
    const out: Record<string, PendingCommand> = {};
    for (const v of Object.values(hub.pendingCommands)) {
      if (v.kind === "start_session") out[v.daemon_id] = v;
    }
    return out;
  }, [hub.pendingCommands]);

  const pendingKillByKey = useMemo(() => {
    const out: Record<string, PendingCommand> = {};
    for (const v of Object.values(hub.pendingCommands)) {
      if (v.kind === "kill_session" && v.session_id) {
        out[`${v.daemon_id}::${v.session_id}`] = v;
      }
    }
    return out;
  }, [hub.pendingCommands]);
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

  if (!bearer) {
    return <SignInScreen loginHref={signInHref} notice={authNotice ?? undefined} />;
  }

  const selectedChatError = selected ? chatErrors[eventKey(selected.daemon_id, selected.session_id)] : undefined;
  const pendingChatSend = selected ? pendingChatSendFor(selected.daemon_id, selected.session_id) : undefined;
  const selectedDaemon = selected ? daemons.find((d) => d.daemon_id === selected.daemon_id) : undefined;
  const selectedSession = selected
    ? selectedDaemon?.sessions.find((s) => s.session_id === selected.session_id)
    : undefined;

  const pendingPermissionInSelectedSession = selected
    ? Object.values(pendingPermissions).find(
        (p) =>
          p.daemon_id === selected.daemon_id &&
          p.session_id === selected.session_id,
      )
    : undefined;

  const pendingPermissionReply = pendingPermissionInSelectedSession
    ? pendingPermissionReplyFor(pendingPermissionInSelectedSession.request_id)
    : undefined;

  return (
    <>
      <AppShell
        device={device}
        connected={connected}
        onOpenSettings={() => setShowSettings(true)}
        onSignOut={() => signOut()}
        sessionActiveOnMobile={!!selected}
        home={
          <HomeScreen
            daemons={daemonModels}
            selectedSessionId={selected?.session_id}
            onSelectSession={(daemon_id, session_id) => setSelected({ daemon_id, session_id })}
            onStartSession={(daemon_id, cwd) => hub.startSession(daemon_id, cwd)}
            onKillSession={(daemon_id, session_id) => hub.killSession(daemon_id, session_id)}
            startSessionErrors={startSessionErrors}
            onDismissStartSessionError={clearStartSessionError}
            pendingStartSessionByDaemon={pendingStartSessionByDaemon}
            pendingKillByKey={pendingKillByKey}
            fsListSender={sendFsList}
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
              pendingPermissionInThisSession={pendingPermissionInSelectedSession}
              pendingPermissionReply={pendingPermissionReply}
              onSendPermissionReply={
                pendingPermissionInSelectedSession
                  ? (decision) => sendPermissionReply(pendingPermissionInSelectedSession, decision)
                  : undefined
              }
              chatError={selectedChatError}
              connected={connected}
              idle={sessionTimeline.idle}
              hasMoreEarlier={sessionTimeline.hasMoreEarlier}
              historyLoading={sessionTimeline.historyLoading}
              historyTimedOut={sessionTimeline.historyTimedOut}
              maxOffset={sessionTimeline.maxOffset}
              unreadCount={sessionTimeline.unreadCount}
              pendingChatSend={pendingChatSend}
              slashEntries={selected ? selectSlashInventory(hub, selected.daemon_id, selected.session_id) : []}
              daemonId={selected.daemon_id}
              fsListSender={sendFsList}
              onMarkSeen={(offset) => markSeen(selected.daemon_id, selected.session_id, offset)}
              onLoadEarlier={sessionTimeline.loadEarlier}
              onSendChat={(content) => hub.sendChat(selected.daemon_id, selected.session_id, content)}
              onSendCliCommand={(text) => hub.sendCliCommand(selected.daemon_id, selected.session_id, text)}
              onBack={() => setSelected(null)}
              onDismissPendingCommand={dismissPendingCommand}
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
          daemons={daemonsHook.daemons}
          onRenameDaemon={daemonsHook.rename}
          onRevokeDaemon={daemonsHook.revoke}
          pushState={pushHook.state}
          onSetSub={pushHook.setSub}
          onResetDaemon={pushHook.resetDaemon}
          onSetDnd={pushHook.setDnd}
          pairing={pairingHook.state}
          onGenerateCode={pairingHook.generate}
          onCancelPairing={pairingHook.cancel}
          daemonActionError={daemonsHook.lastActionError}
          pushActionError={pushHook.lastActionError}
          pairingError={pairingHook.lastError}
          appearance={appearance}
          onSetAppearance={setAppearance}
          onClose={() => setShowSettings(false)}
        />
      )}
      {(() => {
        // Only pop the picker when the user has the corresponding session
        // open. After a refresh hub replays every in-flight question across
        // all daemons; rendering them all on top of the daemons-list view
        // ambushes the user. Confine to the selected session — they re-enter
        // that session to answer, mirroring the local-CC mental model.
        if (!selected) return null;
        const askActive = Object.values(pendingQuestions).find(
          (q) => q.daemon_id === selected.daemon_id && q.session_id === selected.session_id,
        );
        if (!askActive) return null;
        return (
          <AskQuestionSurface
            request={askActive}
            daemonHostname={
              daemons.find((d) => d.daemon_id === askActive.daemon_id)?.hostname ??
              askActive.daemon_id
            }
            device={device}
            onAnswer={(answers) => sendAskAnswer(askActive, answers)}
            onClose={() => {
              // Local-only dismissal; daemon side keeps the request open until
              // expiry or another tab answers. Re-rendering on `pendingQuestions`
              // change will resurface it.
            }}
            pendingReply={hub.pendingCommands[askActive.request_id]}
          />
        );
      })()}
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
