import { useEffect, useState } from "react";
import { useHub, eventKey } from "./ws.ts";
import { consumeFragment, getBearer, loginUrl, clearBearer } from "./auth.ts";
import { SessionPane } from "./SessionPane.tsx";
import { PermissionBanner } from "./PermissionBanner.tsx";
import { registerPushSubscription } from "./push.ts";
import { Settings } from "./Settings.tsx";

const HUB_URL = (import.meta.env.VITE_HUB_URL as string) ?? "ws://localhost:7745";

interface Selected { daemon_id: string; session_id: string }

export function App() {
  const [bearer, setBearer] = useState<string | null>(null);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [newSessionCwd, setNewSessionCwd] = useState<Record<string, string>>({});

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

  const { connected, daemons, events, pendingPermissions, sendPermissionReply, requestHistory, killSession, startSession } = useHub(HUB_URL, bearer);

  if (!bearer) {
    return (
      <main style={{ fontFamily: "system-ui, sans-serif", padding: 24, maxWidth: 720 }}>
        <h1 style={{ margin: 0 }}>cc-remote</h1>
        <p style={{ color: "#666" }}>You're not signed in.</p>
        <a href={loginUrl(HUB_URL)} style={{ display: "inline-block", padding: "8px 16px", background: "#0a0", color: "#fff", textDecoration: "none", borderRadius: 4 }}>
          Sign in
        </a>
      </main>
    );
  }

  const selectedEvents = selected ? (events[eventKey(selected.daemon_id, selected.session_id)] ?? []) : [];

  return (
    <>
      <PermissionBanner pending={pendingPermissions} onReply={sendPermissionReply} />
      <main style={{ fontFamily: "system-ui, sans-serif", padding: 24, maxWidth: 720, paddingRight: selected ? "min(720px, 90vw)" : 24 }}>
        <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <h1 style={{ margin: 0 }}>cc-remote</h1>
          <span>
            <span data-testid="conn-status" style={{ color: connected ? "#0a0" : "#a00", marginRight: 12 }}>
              {connected ? "connected" : "disconnected"}
            </span>
            <button onClick={() => setShowSettings(true)} style={{ fontSize: 12, padding: "4px 8px", marginRight: 8 }}>
              Settings
            </button>
            <button onClick={() => { clearBearer(); setBearer(null); }} style={{ fontSize: 12, padding: "4px 8px" }}>
              Sign out
            </button>
          </span>
        </header>

        {daemons.length === 0 ? (
          <p>No daemons connected yet. Run `cc-remote pair` and then `cc-remote daemon`.</p>
        ) : (
          daemons.map((d) => (
            <section key={d.daemon_id} style={{ marginTop: 24 }}>
              <h2 style={{ margin: "0 0 8px" }}>
                {d.hostname}{" "}
                <small style={{ color: d.online ? "#0a0" : "#888" }}>
                  ({d.daemon_id} · {d.online ? "online" : "offline"})
                </small>
              </h2>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const cwd = newSessionCwd[d.daemon_id]?.trim();
                  if (!cwd) return;
                  startSession(d.daemon_id, cwd);
                  setNewSessionCwd((prev) => ({ ...prev, [d.daemon_id]: "" }));
                }}
                style={{ display: "flex", gap: 6, margin: "0 0 8px", padding: 8, background: "#f0f8ff", border: "1px solid #cde", borderRadius: 4 }}
              >
                <input
                  type="text"
                  placeholder="cwd (e.g. /Users/me/project)"
                  value={newSessionCwd[d.daemon_id] ?? ""}
                  onChange={(e) => setNewSessionCwd((prev) => ({ ...prev, [d.daemon_id]: e.target.value }))}
                  style={{ flex: 1, padding: "4px 8px", fontFamily: "ui-monospace, monospace", fontSize: 12 }}
                />
                <button type="submit" style={{ padding: "4px 12px", background: "#08c", color: "#fff", border: "none", borderRadius: 3, cursor: "pointer" }}>
                  Start session
                </button>
              </form>
              {d.sessions.length === 0 ? (
                <p style={{ color: "#666" }}>No active sessions.</p>
              ) : (
                <ul data-testid={`sessions-${d.daemon_id}`} style={{ paddingLeft: 0, listStyle: "none" }}>
                  {d.sessions.map((s) => {
                    const isSel = selected?.daemon_id === d.daemon_id && selected?.session_id === s.session_id;
                    const evtCount = (events[eventKey(d.daemon_id, s.session_id)] ?? []).length;
                    return (
                      <li
                        key={s.session_id}
                        style={{
                          padding: "8px 12px",
                          marginBottom: 4,
                          background: isSel ? "#e8f5e8" : "#fafafa",
                          border: isSel ? "1px solid #0a0" : "1px solid #eee",
                          borderRadius: 4,
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          gap: 8,
                        }}
                      >
                        <span
                          onClick={() => setSelected({ daemon_id: d.daemon_id, session_id: s.session_id })}
                          style={{ flex: 1, cursor: "pointer" }}
                        >
                          <code>{s.session_id}</code>{" — "}
                          {s.tmux_session ? <span>tmux:{s.tmux_session} · </span> : null}
                          cwd: <code>{s.cwd}</code> · model: <code>{s.model}</code>
                          {evtCount > 0 && <span style={{ marginLeft: 8, color: "#0a0" }}>{evtCount}↓</span>}
                        </span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (confirm(`Kill session ${s.session_id}?`)) {
                              killSession(d.daemon_id, s.session_id);
                            }
                          }}
                          style={{
                            fontSize: 11, padding: "2px 8px", background: "#fff",
                            border: "1px solid #ccc", borderRadius: 3, cursor: "pointer",
                            color: "#a00",
                          }}
                          title="Kill this session"
                        >
                          ✕
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          ))
        )}
      </main>
      {selected && (
        <SessionPane
          daemon_id={selected.daemon_id}
          session_id={selected.session_id}
          events={selectedEvents}
          onClose={() => setSelected(null)}
          onLoadHistory={(before_offset) => requestHistory(selected.daemon_id, selected.session_id, before_offset, 50)}
        />
      )}
      {showSettings && bearer && (
        <Settings hubUrl={HUB_URL} bearer={bearer} onClose={() => setShowSettings(false)} />
      )}
    </>
  );
}
