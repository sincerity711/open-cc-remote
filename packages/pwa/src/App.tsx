import { useEffect, useState } from "react";
import { useHub } from "./ws.ts";
import { consumeFragment, getBearer, loginUrl, clearBearer } from "./auth.ts";

const HUB_URL = (import.meta.env.VITE_HUB_URL as string) ?? "ws://localhost:7745";

export function App() {
  const [bearer, setBearer] = useState<string | null>(null);

  useEffect(() => {
    consumeFragment();
    setBearer(getBearer());
  }, []);

  const { connected, daemons } = useHub(HUB_URL, bearer);

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

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24, maxWidth: 720 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h1 style={{ margin: 0 }}>cc-remote</h1>
        <span>
          <span data-testid="conn-status" style={{ color: connected ? "#0a0" : "#a00", marginRight: 12 }}>
            {connected ? "connected" : "disconnected"}
          </span>
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
            {d.sessions.length === 0 ? (
              <p style={{ color: "#666" }}>No active sessions.</p>
            ) : (
              <ul data-testid={`sessions-${d.daemon_id}`}>
                {d.sessions.map((s) => (
                  <li key={s.session_id}>
                    <code>{s.session_id}</code>{" — "}
                    {s.tmux_session ? <span>tmux:{s.tmux_session} · </span> : null}
                    cwd: <code>{s.cwd}</code> · model: <code>{s.model}</code>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))
      )}
    </main>
  );
}
