import { useHub } from "./ws.ts";

const HUB_URL = (import.meta.env.VITE_HUB_URL as string) ?? "ws://localhost:7745";

export function App() {
  const { connected, daemons } = useHub(HUB_URL);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24, maxWidth: 720 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h1 style={{ margin: 0 }}>cc-remote</h1>
        <span data-testid="conn-status" style={{ color: connected ? "#0a0" : "#a00" }}>
          {connected ? "connected" : "disconnected"}
        </span>
      </header>

      {daemons.length === 0 ? (
        <p>No daemons connected yet. Start `bun run packages/daemon/src/index.ts`.</p>
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
